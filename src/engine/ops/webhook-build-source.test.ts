import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import database from "../../shared/db/connection.ts";
import type { DeployManifest } from "../../shared/rpc.ts";
import type { BuildCommitInput, BuildTransport } from "../build-transport.ts";
import type { OpContext, OpKindDefinition } from "../types.ts";
import { enqueueOperation, markOperationRunning } from "../../shared/db/operations.ts";
import {
  createWebhookBuildSourceDefinition,
  type WebhookBuildSourceInput,
} from "./webhook-build-source.ts";

const COMMIT = "a".repeat(40);
const OLD_DIGEST = `registry.example.com/acme/old@sha256:${"1".repeat(64)}`;
const DIGEST = `sha256:${"b".repeat(64)}`;
const MANIFEST_PATH = ".ocd-deploy.json";

type Fixture = ReturnType<typeof fixture>;
type CapturedTarget = NonNullable<BuildCommitInput["targets"]>[number] & {
  repository?: string;
  branch?: string;
};

function seedWorker(label: string) {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `${label}-${suffix}`,
    provider_id: `${label}-${suffix}`,
    ipv4: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const worker = db.insertBuildWorker({
    serverId: server.id,
    name: `${label}-${suffix}`,
    previousPool: "general",
  });
  return { server, worker };
}

function fixture() {
  const suffix = randomSuffix();
  const assigned = seedWorker("webhook-assigned");
  const source = db.upsertBuildSource({
    repository: `https://github.com/acme/webhook-${suffix}.git`,
    branch: "main",
    workerId: assigned.worker.id,
  });
  const app = db.insertApp({
    name: `webhook-app-${suffix}`,
    domain: "",
    image_ref: OLD_DIGEST,
    container_port: 3000,
    env_vars: "{}",
  });
  db.updateAppBuildConfig(app.id, {
    sourceId: source.id,
    repository: source.repository,
    branch: source.branch,
    dockerfile: "Dockerfile",
    context: ".",
    image: `registry.example.com/acme/${app.name}`,
  });
  database.query("UPDATE apps SET manifest_path = ? WHERE id = ?").run(MANIFEST_PATH, app.id);
  return { assigned, source, app };
}

function manifest(
  seeded: Fixture,
  build: Partial<DeployManifest["build"]> = {},
): DeployManifest {
  return {
    $schema: 1,
    name: seeded.app.name,
    build: {
      repository: seeded.source.repository,
      branch: seeded.source.branch,
      dockerfile: "docker/web.Dockerfile",
      context: "apps/web",
      image: `registry.example.com/acme/${seeded.app.name}`,
      ...build,
    },
    container_port: 3000,
    volume: null,
  };
}

function context(
  definition: OpKindDefinition<WebhookBuildSourceInput>,
  input: WebhookBuildSourceInput,
): OpContext<WebhookBuildSourceInput> {
  const op = enqueueOperation({
    kind: definition.kind,
    resourceKeys: definition.resourceKeys(input),
    input,
    trigger: "webhook",
    triggeredBy: "github",
  });
  markOperationRunning(op.id);
  return {
    opId: op.id,
    kind: "webhook_build_source",
    input,
    trigger: "webhook",
    triggeredBy: "github",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  };
}

function step(definition: OpKindDefinition<WebhookBuildSourceInput>, name: string) {
  const found = definition.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing webhook build step ${name}`);
  return found;
}

function inMemoryTransport(
  repositoryFiles: Record<string, string>,
  options: { online?: boolean; onlineServerId?: number } = {},
): BuildTransport & {
  probes: number[];
  builds: BuildCommitInput[];
  targets: CapturedTarget[];
  reads: string[];
  verifications: string[];
} {
  const probes: number[] = [];
  const builds: BuildCommitInput[] = [];
  const targets: CapturedTarget[] = [];
  const reads: string[] = [];
  const verifications: string[] = [];
  return {
    probes,
    builds,
    targets,
    reads,
    verifications,
    probeWorker: async (server) => {
      probes.push(server.id);
      const online = options.online !== false &&
        (options.onlineServerId === undefined || options.onlineServerId === server.id);
      return {
        online,
        version: "test",
        architecture: "x86_64",
        diskFreeBytes: 50 * 1024 ** 3,
        error: online ? "" : "worker offline",
      };
    },
    buildCommit: async (request) => {
      builds.push(request);
      const loaded: Record<string, string> = {};
      const readFile = async (path: string): Promise<string> => {
        if (loaded[path] !== undefined) return loaded[path];
        const content = repositoryFiles[path];
        if (content === undefined) throw new Error(`Missing in-memory repository file: ${path}`);
        reads.push(path);
        loaded[path] = content;
        return content;
      };
      for (const path of [...new Set(request.readFiles || [])]) await readFile(path);
      const resolved = request.resolveTargets
        ? await request.resolveTargets(readFile)
        : request.targets || [];
      targets.push(...resolved);
      const refs = new Map(resolved.map((target) => [target.name, `${target.image}@${DIGEST}`]));
      for (const [name, image] of refs) await request.onArtifact?.(name, image);
      return {
        refs,
        files: loaded,
      };
    },
    verifyArtifact: async ({ image }) => {
      verifications.push(image);
      return true;
    },
  };
}

function input(sourceId: number): WebhookBuildSourceInput {
  return { sourceId, commit: COMMIT, deliveryId: `delivery-${randomSuffix()}` };
}

describe("webhook build source transport boundary", () => {
  test("prepares source metadata without reserving or probing a worker", async () => {
    const seeded = fixture();
    const transport = inMemoryTransport({});
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(definition, input(seeded.source.id));

    const prepared = await step(definition, "prepare_source").run(ctx, {}) as { appIds: number[] };

    expect(prepared).toEqual({ appIds: [seeded.app.id] });
    expect(transport.probes).toEqual([]);
    expect(db.getBuildWorkerLeaseForOperation(ctx.opId)).toBeNull();
    expect(db.getBuildSource(seeded.source.id)).toMatchObject({
      last_status: "building",
      last_error: "",
    });
  });

  test("builds targets derived from the committed manifest at the exact webhook commit", async () => {
    const seeded = fixture();
    const rawManifest = JSON.stringify(manifest(seeded));
    const transport = inMemoryTransport({ [MANIFEST_PATH]: rawManifest });
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(definition, input(seeded.source.id));

    const prepared = await step(definition, "prepare_source").run(ctx, {});
    const built = await step(definition, "build_images").run(ctx, { prepare_source: prepared }) as {
      refs: Record<string, string>;
      files: Record<string, string>;
      builds: Record<string, DeployManifest["build"]>;
      workerId: number;
    };

    expect(transport.builds).toHaveLength(1);
    expect(transport.builds[0]).toMatchObject({
      server: { id: seeded.assigned.server.id },
      operationId: ctx.opId,
      repository: seeded.source.repository,
      commit: COMMIT,
      readFiles: [MANIFEST_PATH],
    });
    expect(transport.reads).toEqual([MANIFEST_PATH]);
    expect(transport.targets).toEqual([{
      name: seeded.app.name,
      repository: seeded.source.repository,
      branch: seeded.source.branch,
      dockerfile: "docker/web.Dockerfile",
      context: "apps/web",
      image: `registry.example.com/acme/${seeded.app.name}`,
    }]);
    expect(built.refs).toEqual({
      [seeded.app.name]: `registry.example.com/acme/${seeded.app.name}@${DIGEST}`,
    });
    expect(built.files).toEqual({ [MANIFEST_PATH]: rawManifest });
    expect(built.builds[seeded.app.name]).toEqual(manifest(seeded).build);
    expect(built.workerId).toBe(seeded.assigned.worker.id);
    expect(db.getBuildWorkerLeaseForOperation(ctx.opId)).toBeNull();
    expect(db.listBuildArtifacts(ctx.opId)).toHaveLength(1);
    const adopted = await step(definition, "build_images").probe!(ctx, { prepare_source: prepared });
    expect(adopted).toEqual(built);
    expect(transport.builds).toHaveLength(1);
    expect(transport.verifications).toEqual([built.refs[seeded.app.name]]);
  });

  test("rejects a committed manifest that changes the source repository", async () => {
    const seeded = fixture();
    const transport = inMemoryTransport({
      [MANIFEST_PATH]: JSON.stringify(manifest(seeded, {
        repository: "https://github.com/acme/different.git",
      })),
    });
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(definition, input(seeded.source.id));
    const prepared = await step(definition, "prepare_source").run(ctx, {});

    await expect(step(definition, "build_images").run(ctx, { prepare_source: prepared }))
      .rejects.toThrow(/changed repository/);
    expect(transport.targets).toHaveLength(0);
    expect(db.getBuildWorkerLeaseForOperation(ctx.opId)).toBeNull();
  });

  test("rejects a committed manifest that changes the webhook branch", async () => {
    const seeded = fixture();
    const transport = inMemoryTransport({
      [MANIFEST_PATH]: JSON.stringify(manifest(seeded, { branch: "release" })),
    });
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(definition, input(seeded.source.id));
    const prepared = await step(definition, "prepare_source").run(ctx, {});

    await expect(step(definition, "build_images").run(ctx, { prepare_source: prepared }))
      .rejects.toThrow(/changed webhook branch/);
    expect(transport.targets).toHaveLength(0);
    expect(db.getBuildWorkerLeaseForOperation(ctx.opId)).toBeNull();
  });

  test("fails over from an offline affinity worker and records the actual worker", async () => {
    const seeded = fixture();
    const fallback = seedWorker("webhook-fallback");
    const transport = inMemoryTransport(
      { [MANIFEST_PATH]: JSON.stringify(manifest(seeded)) },
      { onlineServerId: fallback.server.id },
    );
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(definition, input(seeded.source.id));
    const prepared = await step(definition, "prepare_source").run(ctx, {});
    const built = await step(definition, "build_images").run(ctx, { prepare_source: prepared });

    expect(transport.builds[0].server.id).toBe(fallback.server.id);
    expect((built as { workerId: number }).workerId).toBe(fallback.worker.id);
    await step(definition, "finish_delivery").run(ctx, { build_images: built });
    expect(db.getBuildSource(seeded.source.id)?.worker_id).toBe(fallback.worker.id);
  });
});
