import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import type { DeployRequest, StackDeployRequest } from "../../shared/rpc.ts";
import type { BuildCommitInput, BuildTransport } from "../build-transport.ts";
import type { OpContext, OpKindDefinition } from "../types.ts";
import { enqueueOperation, markOperationRunning } from "../../shared/db/operations.ts";
import {
  createBuildDeliveryDefinitions,
  type BuildAppDeliveryInput,
  type BuildStackDeliveryInput,
} from "./build-delivery.ts";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function seedWorker(name: string) {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `${name}-${suffix}`,
    provider_id: `${name}-${suffix}`,
    ipv4: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const worker = db.insertBuildWorker({ serverId: server.id, name: `${name}-${suffix}`, previousPool: "general" });
  return { server, worker };
}

function context<Input>(definition: OpKindDefinition<Input>, input: Input): OpContext<Input> {
  const op = enqueueOperation({
    kind: definition.kind,
    resourceKeys: definition.resourceKeys(input),
    input,
    trigger: "test",
    triggeredBy: "tester",
  });
  markOperationRunning(op.id);
  return {
    opId: op.id,
    kind: definition.kind,
    input,
    trigger: "test",
    triggeredBy: "tester",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  };
}

function step<Input>(definition: OpKindDefinition<Input>, name: string) {
  const found = definition.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing build-delivery step ${name}`);
  return found;
}

function transport(input: {
  onlineServerId?: number;
  builds: BuildCommitInput[];
}): BuildTransport {
  return {
    probeWorker: async (server) => ({
      online: input.onlineServerId === undefined || server.id === input.onlineServerId,
      version: "test",
      architecture: "x86_64",
      diskFreeBytes: 50 * 1024 ** 3,
      error: input.onlineServerId === undefined || server.id === input.onlineServerId ? "" : "offline",
    }),
    buildCommit: async (request) => {
      input.builds.push(request);
      const refs = new Map((request.targets || []).map((target) => [target.name, `${target.image}@${DIGEST}`]));
      for (const [name, image] of refs) await request.onArtifact?.(name, image);
      return {
        refs,
        files: {},
      };
    },
    verifyArtifact: async () => true,
  };
}

function appSpec(name: string): DeployRequest {
  return {
    app_name: name,
    container_port: 3000,
    git_commit: COMMIT,
    build: {
      repository: "https://github.com/acme/widgets.git",
      branch: "main",
      dockerfile: "docker/app.Dockerfile",
      context: ".",
      image: `registry.example.com/acme/${name}`,
    },
  };
}

describe("build delivery transport boundary", () => {
  test("checks out and builds the exact app request through the injected transport", async () => {
    const { server } = seedWorker("single");
    const builds: BuildCommitInput[] = [];
    const definitions = createBuildDeliveryDefinitions(transport({ onlineServerId: server.id, builds }));
    const input: BuildAppDeliveryInput = { spec: appSpec(`app-${randomSuffix()}`) };
    const ctx = context(definitions.appDefinition, input);

    const built = await step(definitions.appDefinition, "build_and_push").run(ctx, {});

    expect(builds).toHaveLength(1);
    expect(builds[0].commit).toBe(COMMIT);
    expect(builds[0].repository).toBe(input.spec.build!.repository);
    expect(builds[0].signal?.aborted).toBe(false);
    expect(builds[0].targets).toEqual([{
      name: input.spec.app_name,
      dockerfile: "docker/app.Dockerfile",
      context: ".",
      image: input.spec.build!.image,
    }]);
    expect((built as { refs: Record<string, string>; workerId: number }).refs[input.spec.app_name])
      .toBe(`${input.spec.build!.image}@${DIGEST}`);
    expect((built as { workerId: number }).workerId).toBe(db.getBuildWorkerByServerId(server.id)!.id);
    expect(db.getBuildWorkerLeaseForOperation(ctx.opId)).toBeNull();
    expect(db.listBuildArtifacts(ctx.opId)).toHaveLength(1);
    expect(db.getBuildResultCheckpoint(ctx.opId)?.output_json).not.toContain("lease_token");
    const adopted = await step(definitions.appDefinition, "build_and_push").probe!(ctx, {});
    expect(adopted).toEqual(built);
    expect(builds).toHaveLength(1);
  });

  test("skips offline workers and selects an online worker", async () => {
    seedWorker("offline");
    const online = seedWorker("online");
    const builds: BuildCommitInput[] = [];
    const definitions = createBuildDeliveryDefinitions(transport({ onlineServerId: online.server.id, builds }));
    const input: BuildAppDeliveryInput = { spec: appSpec(`select-${randomSuffix()}`) };

    const ctx = context(definitions.appDefinition, input);
    await step(definitions.appDefinition, "build_and_push").run(ctx, {});

    expect(builds[0].server.id).toBe(online.server.id);
  });

  test("builds every selected stack target at one exact commit before deployment", async () => {
    const { server } = seedWorker("stack");
    const builds: BuildCommitInput[] = [];
    const definitions = createBuildDeliveryDefinitions(transport({ onlineServerId: server.id, builds }));
    const web = appSpec("web");
    const worker = appSpec("worker");
    const spec = {
      name: `stack-${randomSuffix()}`,
      apps: [
        { key: "web", build: web.build, git_commit: COMMIT },
        { key: "worker", build: worker.build, git_commit: COMMIT },
      ],
      services: [],
      selected_app_keys: ["web", "worker"],
    } as unknown as StackDeployRequest;
    const input: BuildStackDeliveryInput = { spec };
    const ctx = context(definitions.stackDefinition, input);

    const built = await step(definitions.stackDefinition, "build_and_push").run(ctx, {});

    expect(builds).toHaveLength(1);
    expect(builds[0].targets?.map((target) => target.name)).toEqual(["web", "worker"]);
    expect(Object.keys((built as { refs: Record<string, string> }).refs).sort()).toEqual(["web", "worker"]);
  });

  test("does not accept stack members from different source commits", async () => {
    const { server } = seedWorker("mixed-commit");
    const builds: BuildCommitInput[] = [];
    const definitions = createBuildDeliveryDefinitions(transport({ onlineServerId: server.id, builds }));
    const base = appSpec("mixed");
    const spec = {
      name: `stack-${randomSuffix()}`,
      apps: [
        { key: "a", build: base.build, git_commit: COMMIT },
        { key: "b", build: base.build, git_commit: "c".repeat(40) },
      ],
      services: [],
    } as unknown as StackDeployRequest;
    const input: BuildStackDeliveryInput = { spec };
    const ctx = context(definitions.stackDefinition, input);

    await expect(step(definitions.stackDefinition, "build_and_push").run(ctx, {}))
      .rejects.toThrow(/one exact Git commit/);
    expect(builds).toHaveLength(0);
  });
});
