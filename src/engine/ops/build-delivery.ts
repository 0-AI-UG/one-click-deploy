import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import type { DeployRequest, StackDeployRequest } from "../../shared/rpc.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { buildCommitOnWorker, probeBuildWorker, type BuildTarget } from "../build-worker.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";

type BuildConfig = NonNullable<DeployRequest["build"]>;
type WorkerOut = { workerId: number; serverId: number };
type BuiltOut = { refs: Record<string, string> };

export type BuildAppDeliveryInput = { spec: DeployRequest; userId?: string };
export type BuildStackDeliveryInput = { spec: StackDeployRequest; userId?: string };

function sourceKey(build: BuildConfig): string {
  return `${build.repository}#${build.branch || "main"}`;
}

async function readyWorker(): Promise<WorkerOut> {
  for (const worker of db.getBuildWorkers()) {
    const server = db.getServer(worker.server_id);
    if (!server || server.status !== "ready") continue;
    const observed = await probeBuildWorker(server);
    if (!observed.online) continue;
    db.updateBuildWorker(worker.id, {
      status: "online",
      last_error: "",
      worker_version: observed.version,
      architecture: observed.architecture,
      last_checked_at: new Date().toISOString(),
    });
    return { workerId: worker.id, serverId: server.id };
  }
  throw new Error("No online OCD build worker is available");
}

async function runBuild(
  ctx: OpContext<any>,
  worker: WorkerOut,
  repository: string,
  commit: string,
  targets: BuildTarget[],
): Promise<BuiltOut> {
  const server = db.getServer(worker.serverId);
  if (!server) throw new Error("Build worker server disappeared");
  const settings = db.getSettings();
  const built = await buildCommitOnWorker({
    server,
    operationId: ctx.opId,
    repository,
    commit,
    targets,
    gitUsername: settings.github_build_username || "x-access-token",
    gitToken: await secretStore.get("github_build_token") || undefined,
    registryUsername: settings.oci_registry_username || undefined,
    registryPassword: await secretStore.get("oci_registry_password") || undefined,
    onLog: (line) => ctx.log(line),
  });
  return { refs: Object.fromEntries(built.refs) };
}

async function runChild(
  ctx: OpContext<any>,
  suffix: string,
  kind: string,
  resourceKeys: string[],
  input: Record<string, unknown>,
): Promise<number> {
  const key = `build-delivery:${ctx.opId}:${suffix}`;
  const existing = listChildOperations(ctx.opId).find((op) => op.idempotency_key === key);
  const child = existing ?? enqueueOperation({
    kind,
    resourceKeys,
    input,
    trigger: ctx.trigger === "webhook" ? "webhook" : "build",
    triggeredBy: ctx.triggeredBy,
    parentId: ctx.opId,
    idempotencyKey: key,
  });
  await awaitChildren(ctx, { childIds: [child.id] });
  return child.id;
}

async function persistBuildConfig(appId: number, build: BuildConfig, workerId: number): Promise<void> {
  const source = db.upsertBuildSource({
    repository: build.repository,
    branch: build.branch || "main",
    workerId,
    webhookEnabled: build.webhook !== false,
  });
  db.updateAppBuildConfig(appId, {
    sourceId: source.id,
    repository: build.repository,
    branch: build.branch || "main",
    dockerfile: build.dockerfile,
    context: build.context,
    image: build.image,
  });
  if (build.webhook !== false && !(await secretStore.get(`build_source_webhook:${source.id}`))) {
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await secretStore.set(`build_source_webhook:${source.id}`, secret);
  }
}

const appWorker: Step<BuildAppDeliveryInput, WorkerOut> = {
  name: "select_build_worker",
  label: "Select build worker",
  async run() { return readyWorker(); },
};

const appBuild: Step<BuildAppDeliveryInput, BuiltOut> = {
  name: "build_and_push",
  label: "Build and push image",
  async run(ctx, prior) {
    const build = ctx.input.spec.build;
    if (!build) throw new Error("Build configuration missing");
    const commit = ctx.input.spec.git_commit || "";
    return runBuild(ctx, prior.select_build_worker as WorkerOut, build.repository, commit, [{
      name: ctx.input.spec.app_name,
      dockerfile: build.dockerfile,
      context: build.context,
      image: build.image,
    }]);
  },
};

const appDeploy: Step<BuildAppDeliveryInput, { childId: number; appId: number }> = {
  name: "deploy_digest",
  label: "Reconcile manifest and deploy digest",
  async run(ctx, prior) {
    const build = ctx.input.spec.build!;
    const image = (prior.build_and_push as BuiltOut).refs[ctx.input.spec.app_name];
    if (!image) throw new Error("Build did not produce an image reference");
    const runtime: DeployRequest = { ...ctx.input.spec, build: undefined, image_ref: image };
    const existing = db.getAppByName(runtime.app_name);
    const childId = existing
      ? await runChild(ctx, "app", "apply_manifest", [`manifest:${existing.id}`], {
          appId: existing.id,
          userId: ctx.input.userId,
          deploy: true,
          spec: runtime,
        })
      : await runChild(ctx, "app", "deploy", [`app:create:${runtime.app_name}`], runtime as unknown as Record<string, unknown>);
    const app = db.getAppByName(runtime.app_name);
    if (!app) throw new Error("Built app was not persisted after deployment");
    await persistBuildConfig(app.id, build, (prior.select_build_worker as WorkerOut).workerId);
    return { childId, appId: app.id };
  },
};

const appDefinition: OpKindDefinition<BuildAppDeliveryInput> = {
  kind: "build_app_delivery",
  label: "Build and deploy app",
  resourceKeys: (input) => [`build:${sourceKey(input.spec.build!)}`, `app-delivery:${input.spec.app_name}`],
  steps: [appWorker, appBuild, appDeploy],
};

const stackWorker: Step<BuildStackDeliveryInput, WorkerOut> = {
  name: "select_build_worker",
  label: "Select build worker",
  async run() { return readyWorker(); },
};

const stackBuild: Step<BuildStackDeliveryInput, BuiltOut> = {
  name: "build_and_push",
  label: "Build and push stack images",
  async run(ctx, prior) {
    const selected = ctx.input.spec.selected_app_keys
      ? ctx.input.spec.apps.filter((app) => ctx.input.spec.selected_app_keys!.includes(app.key))
      : ctx.input.spec.apps;
    if (!selected.length) return { refs: {} };
    const builds = selected.map((app) => app.build).filter((build): build is BuildConfig => !!build);
    if (builds.length !== selected.length) throw new Error("Every selected stack member requires build configuration");
    const keys = new Set(builds.map(sourceKey));
    if (keys.size !== 1) throw new Error("One stack build must use one repository and branch");
    const commit = selected[0].git_commit || "";
    if (selected.some((app) => app.git_commit !== commit)) throw new Error("Stack members must use one exact Git commit");
    return runBuild(
      ctx,
      prior.select_build_worker as WorkerOut,
      builds[0].repository,
      commit,
      selected.map((app) => ({
        name: app.key,
        dockerfile: app.build!.dockerfile,
        context: app.build!.context,
        image: app.build!.image,
      })),
    );
  },
};

const stackDeploy: Step<BuildStackDeliveryInput, { childId: number }> = {
  name: "deploy_digests",
  label: "Reconcile stack and deploy digests",
  async run(ctx, prior) {
    const refs = (prior.build_and_push as BuiltOut).refs;
    const runtime: StackDeployRequest = {
      ...ctx.input.spec,
      apps: ctx.input.spec.apps.map((app) => ({
        ...app,
        build: undefined,
        image_ref: refs[app.key] || db.getAppByName(`${ctx.input.spec.name}-${app.key}`)?.image_ref,
      })),
    };
    const childId = await runChild(ctx, "stack", "deploy_stack", [`stack:${runtime.name}`], runtime as unknown as Record<string, unknown>);
    const workerId = (prior.select_build_worker as WorkerOut).workerId;
    for (const appSpec of ctx.input.spec.apps) {
      if (!appSpec.build) continue;
      const app = db.getAppByName(`${ctx.input.spec.name}-${appSpec.key}`);
      if (app) await persistBuildConfig(app.id, appSpec.build, workerId);
    }
    return { childId };
  },
};

const stackDefinition: OpKindDefinition<BuildStackDeliveryInput> = {
  kind: "build_stack_delivery",
  label: "Build and deploy stack",
  resourceKeys: (input) => [`build-stack:${input.spec.name}`],
  steps: [stackWorker, stackBuild, stackDeploy],
};

registerOp(appDefinition as OpKindDefinition<any>);
registerOp(stackDefinition as OpKindDefinition<any>);
export { appDefinition, stackDefinition };
