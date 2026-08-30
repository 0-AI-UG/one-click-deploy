import { createHash } from "node:crypto";
import { posix } from "node:path";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { DeployManifest, StackDeployRequest, StackManifest } from "../../shared/rpc.ts";
import { validateDeployManifest, validateStackManifest } from "../../shared/manifest-validate.ts";
import { buildStackAppSpec } from "../../shared/stack-spec.ts";
import { deployRequestFromApp } from "../../shared/app-config.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { sshBuildTransport, type BuildTransport } from "../build-transport.ts";
import { createBuildCoordinator, type BuildCoordinator } from "../build-coordinator.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";
import { resolveSourceCredentialsForRepository } from "../source-config.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";

export type WebhookBuildSourceInput = { sourceId: number; commit: string; deliveryId: string };
type Prepared = { appIds: number[] };
type BuildConfig = NonNullable<import("../../shared/rpc.ts").DeployRequest["build"]>;
type Built = {
  refs: Record<string, string>;
  files: Record<string, string>;
  builds: Record<string, BuildConfig>;
  workerId: number;
};

function parseJson<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; } catch { throw new Error(`${label} is not valid JSON`); }
}

function sameRepository(left: string, right: string): boolean {
  return left.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase() ===
    right.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function assertSourceBuild(build: BuildConfig, source: db.BuildSourceRow, label: string): void {
  if (!sameRepository(build.repository, source.repository)) throw new Error(`${label} changed repository; apply it manually before enabling that source`);
  if ((build.branch || "main") !== source.branch) throw new Error(`${label} changed webhook branch; apply it manually before enabling that source`);
}

function environmentId(name: string, label: string): number {
  const environment = db.getEnvironments().find((candidate) => candidate.name === name && !candidate.deleted_at);
  if (!environment) throw new Error(`${label} selects missing environment ${name}`);
  return environment.id;
}

async function child(ctx: OpContext<WebhookBuildSourceInput>, suffix: string, kind: string, keys: string[], input: unknown): Promise<number> {
  const idempotency = `webhook-source:${ctx.opId}:${suffix}`;
  const existing = listChildOperations(ctx.opId).find((op) => op.idempotency_key === idempotency);
  const op = existing ?? enqueueOperation({
    kind,
    resourceKeys: keys,
    input,
    trigger: "webhook",
    triggeredBy: ctx.triggeredBy,
    parentId: ctx.opId,
    idempotencyKey: idempotency,
  });
  await awaitChildren(ctx, { childIds: [op.id] });
  return op.id;
}

export function createWebhookBuildSourceDefinition(
  transport: BuildTransport = sshBuildTransport,
  coordinator: BuildCoordinator = createBuildCoordinator(transport),
): OpKindDefinition<WebhookBuildSourceInput> {
const prepare: Step<WebhookBuildSourceInput, Prepared> = {
  name: "prepare_source",
  label: "Prepare repository build",
  async run(ctx) {
    const source = db.getBuildSource(ctx.input.sourceId);
    if (!source) throw new Error("Build source not found");
    if (!/^[0-9a-f]{40,64}$/i.test(ctx.input.commit)) throw new Error("Webhook commit is invalid");
    const apps = db.appsForBuildSource(source.id) as AppRow[];
    if (!apps.length) throw new Error("Build source has no attached apps");
    db.updateBuildSourceDelivery(source.id, { last_status: "building", last_error: "" });
    return { appIds: apps.map((app) => app.id) };
  },
  async compensate(ctx) {
    db.updateBuildSourceDelivery(ctx.input.sourceId, {
      last_status: "failed",
      last_error: `Webhook operation #${ctx.opId} failed; inspect its operation logs`,
    });
  },
};

const build: Step<WebhookBuildSourceInput, Built> = {
  name: "build_images",
  label: "Build repository images",
  async run(ctx, prior) {
    const source = db.getBuildSource(ctx.input.sourceId)!;
    const prepared = prior.prepare_source as Prepared;
    const apps = prepared.appIds.map((id) => db.getApp(id)).filter((app): app is AppRow => !!app && app.target_of == null);
    const roots = apps.flatMap((app) => [app.stack_id == null ? app.manifest_path : null, app.stack_manifest_path])
      .filter((path): path is string => !!path);
    const builds: Record<string, BuildConfig> = {};
    const sourceCredentials = await resolveSourceCredentialsForRepository(source.repository);
    const coordinated = await coordinator.withWorker({
      operationId: ctx.opId,
      preferredWorkerId: source.worker_id,
      run: ({ server }) => transport.buildCommit({
        server,
        operationId: ctx.opId,
        repository: source.repository,
        commit: ctx.input.commit,
        readFiles: roots,
        resolveTargets: async (readFile) => {
          const targets: Array<{ name: string; dockerfile: string; context: string; image: string }> = [];
          for (const app of apps.filter((candidate) => candidate.stack_id == null)) {
            if (!app.manifest_path) throw new Error(`${app.name} has no committed manifest path`);
            const manifest = parseJson<DeployManifest>(await readFile(app.manifest_path), app.manifest_path);
            validateDeployManifest(manifest, app.manifest_path);
            assertSourceBuild(manifest.build, source, app.manifest_path);
            builds[app.name] = manifest.build;
            targets.push({ name: app.name, ...manifest.build });
          }
          const stackIds = [...new Set(apps.map((app) => app.stack_id).filter((id): id is number => id != null))];
          for (const stackId of stackIds) {
            const stack = db.getStack(stackId);
            const member = apps.find((app) => app.stack_id === stackId);
            const stackPath = member?.stack_manifest_path;
            if (!stack || !stackPath) throw new Error(`Stack ${stackId} has no committed manifest path`);
            const stackManifest = parseJson<StackManifest>(await readFile(stackPath), stackPath);
            validateStackManifest(stackManifest, stackPath);
            if (stackManifest.name !== stack.name) throw new Error(`${stackPath} changed stack name; apply it manually`);
            for (const [key, entry] of Object.entries(stackManifest.apps)) {
              const path = posix.normalize(posix.join(posix.dirname(stackPath), entry.manifest));
              const manifest = parseJson<DeployManifest>(await readFile(path), path);
              validateDeployManifest(manifest, path);
              assertSourceBuild(manifest.build, source, path);
              const name = `${stack.name}-${key}`;
              builds[name] = manifest.build;
              targets.push({ name, ...manifest.build });
            }
          }
          return targets;
        },
        gitUsername: sourceCredentials.username,
        gitToken: sourceCredentials.token,
        resolveRegistryCredentials: resolveRegistryCredentialsForImage,
        onLog: (line) => ctx.log(line),
      }),
    });
    return {
      refs: Object.fromEntries(coordinated.value.refs),
      files: coordinated.value.files,
      builds,
      workerId: coordinated.workerId,
    };
  },
};

function manifestHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const reconcile: Step<WebhookBuildSourceInput, { childIds: number[] }> = {
  name: "reconcile_manifests",
  label: "Reconcile repository manifests",
  async run(ctx, prior) {
    const prepared = prior.prepare_source as Prepared;
    const built = prior.build_images as Built;
    const apps = prepared.appIds.map((id) => db.getApp(id)).filter((app): app is AppRow => !!app && app.target_of == null);
    const childIds: number[] = [];
    const stacks = new Map<number, AppRow[]>();
    const standalone: AppRow[] = [];
    for (const app of apps) {
      if (app.stack_id == null) standalone.push(app);
      else stacks.set(app.stack_id, [...(stacks.get(app.stack_id) || []), app]);
    }

    for (const app of standalone) {
      if (!app.manifest_path || !built.files[app.manifest_path]) throw new Error(`${app.name} has no readable committed manifest`);
      const raw = built.files[app.manifest_path];
      const manifest = parseJson<DeployManifest>(raw, app.manifest_path);
      validateDeployManifest(manifest, app.manifest_path);
      const mapped = buildStackAppSpec(app.name, { manifest: app.manifest_path }, manifest, "", "");
      const desired = {
        ...deployRequestFromApp(app),
        ...mapped,
        app_name: app.name,
        key: undefined,
        build: undefined,
        image_ref: built.refs[app.name],
        git_commit: ctx.input.commit,
        environment_id: manifest.environment === undefined
          ? app.environment_id
          : manifest.environment === null ? null : environmentId(manifest.environment, app.manifest_path),
        manifest_path: app.manifest_path,
        manifest_hash: manifestHash(raw),
      };
      if (!desired.image_ref) throw new Error(`No built digest for ${app.name}`);
      childIds.push(await child(ctx, `app:${app.id}`, "apply_manifest", [`manifest:${app.id}`], {
        appId: app.id,
        userId: app.deployed_by || undefined,
        deploy: true,
        spec: desired,
      }));
      const build = built.builds[app.name];
      if (build) db.updateAppBuildConfig(app.id, {
        sourceId: ctx.input.sourceId,
        repository: build.repository,
        branch: build.branch || "main",
        dockerfile: build.dockerfile,
        context: build.context,
        image: build.image,
      });
    }

    for (const [stackId, members] of stacks) {
      const stack = db.getStack(stackId);
      if (!stack) throw new Error(`Stack ${stackId} disappeared`);
      const stackPath = members[0].stack_manifest_path;
      if (!stackPath || !built.files[stackPath]) throw new Error(`${stack.name} has no readable committed stack manifest`);
      const rawStack = built.files[stackPath];
      const manifest = parseJson<StackManifest>(rawStack, stackPath);
      validateStackManifest(manifest, stackPath);
      const specs = Object.entries(manifest.apps).map(([key, entry]) => {
        const app = members.find((candidate) => candidate.name === `${stack.name}-${key}`);
        const path = posix.normalize(posix.join(posix.dirname(stackPath), entry.manifest));
        const raw = built.files[path];
        if (!raw) throw new Error(`Missing committed member manifest: ${path}`);
        const childManifest = parseJson<DeployManifest>(raw, path);
        validateDeployManifest(childManifest, path);
        const spec = buildStackAppSpec(key, entry, childManifest, "", "");
        return {
          ...spec,
          build: undefined,
          image_ref: built.refs[`${stack.name}-${key}`],
          git_commit: ctx.input.commit,
          manifest_path: path,
          manifest_hash: manifestHash(raw),
          reconcile_mode: "artifact" as const,
        };
      });
      const stackRequest: StackDeployRequest = {
        name: stack.name,
        stack_manifest_path: stackPath,
        environment_id: manifest.environment
          ? environmentId(manifest.environment, stackPath)
          : stack.environment_id ?? undefined,
        staging_environment_id: manifest.staging_environment === null
          ? null
          : manifest.staging_environment
            ? environmentId(manifest.staging_environment, stackPath)
            : stack.staging_environment_id ?? undefined,
        services: Object.entries(manifest.services || {}).map(([key, service]) => ({ key, ...service })),
        apps: specs,
        selected_app_keys: specs.map((spec) => spec.key),
        selected_service_keys: Object.keys(manifest.services || {}),
        partial: false,
      };
      childIds.push(await child(ctx, `stack:${stack.id}`, "deploy_stack", [`stack:${stack.id}`, `stack:${stack.name}`], stackRequest));
      for (const spec of specs) {
        const app = db.getAppByName(`${stack.name}-${spec.key}`);
        const build = built.builds[`${stack.name}-${spec.key}`];
        if (app && build) db.updateAppBuildConfig(app.id, {
          sourceId: ctx.input.sourceId,
          repository: build.repository,
          branch: build.branch || "main",
          dockerfile: build.dockerfile,
          context: build.context,
          image: build.image,
        });
      }
    }
    return { childIds };
  },
};

const finish: Step<WebhookBuildSourceInput, { ok: true }> = {
  name: "finish_delivery",
  label: "Record webhook delivery",
  async run(ctx, prior) {
    const built = prior.build_images as Built;
    if (built.workerId != null) db.updateBuildSourceWorker(ctx.input.sourceId, built.workerId);
    db.updateBuildSourceDelivery(ctx.input.sourceId, {
      last_status: "deployed",
      last_error: "",
      last_commit: ctx.input.commit,
      last_delivery_id: ctx.input.deliveryId,
    });
    return { ok: true };
  },
};

const definition: OpKindDefinition<WebhookBuildSourceInput> = {
  kind: "webhook_build_source",
  label: "Webhook build and manifest reconcile",
  resourceKeys: (input) => [`build-source:${input.sourceId}`],
  steps: [prepare, build, reconcile, finish],
};

return definition;
}

const definition = createWebhookBuildSourceDefinition();

registerOp(definition as OpKindDefinition<any>);
export default definition;
