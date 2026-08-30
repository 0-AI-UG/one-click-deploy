import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import database from "../../shared/db/connection.ts";
import type { DeployManifest } from "../../shared/rpc.ts";
import type { BuildCommitInput, BuildTransport } from "../build-transport.ts";
import type { OpContext, OpKindDefinition } from "../types.ts";
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

function context(input: WebhookBuildSourceInput): OpContext<WebhookBuildSourceInput> {
  return {
    opId: Math.floor(Math.random() * 1_000_000) + 1,
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
  options: { online?: boolean } = {},
): BuildTransport & {
  probes: number[];
  builds: BuildCommitInput[];
  targets: CapturedTarget[];
  reads: string[];
} {
  const probes: number[] = [];
  const builds: BuildCommitInput[] = [];
  const targets: CapturedTarget[] = [];
  const reads: string[] = [];
  return {
    probes,
    builds,
    targets,
    reads,
    probeWorker: async (server) => {
      probes.push(server.id);
      return {
        online: options.online !== false,
        version: "test",
        architecture: "x86_64",
        diskFreeBytes: 50 * 1024 ** 3,
        error: options.online === false ? "worker offline" : "",
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
      return {
        refs: new Map(resolved.map((target) => [target.name, `${target.image}@${DIGEST}`])),
        files: loaded,
      };
    },
  };
}

function input(sourceId: number): WebhookBuildSourceInput {
  return { sourceId, commit: COMMIT, deliveryId: `delivery-${randomSuffix()}` };
}

describe("webhook build source transport boundary", () => {
  test("prepares the source's assigned worker and records building state", async () => {
    const seeded = fixture();
    const unrelated = seedWorker("webhook-unrelated");
    const transport = inMemoryTransport({});
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(input(seeded.source.id));

    const prepared = await step(definition, "prepare_source").run(ctx, {}) as {
      workerId: number;
      serverId: number;
      appIds: number[];
    };

    expect(prepared).toEqual({
      workerId: seeded.assigned.worker.id,
      serverId: seeded.assigned.server.id,
      appIds: [seeded.app.id],
    });
    expect(transport.probes).toEqual([seeded.assigned.server.id]);
    expect(transport.probes).not.toContain(unrelated.server.id);
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
    const ctx = context(input(seeded.source.id));

    const prepared = await step(definition, "prepare_source").run(ctx, {});
    const built = await step(definition, "build_images").run(ctx, { prepare_source: prepared }) as {
      refs: Record<string, string>;
      files: Record<string, string>;
      builds: Record<string, DeployManifest["build"]>;
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
  });

  test("rejects a committed manifest that changes the source repository", async () => {
    const seeded = fixture();
    const transport = inMemoryTransport({
      [MANIFEST_PATH]: JSON.stringify(manifest(seeded, {
        repository: "https://github.com/acme/different.git",
      })),
    });
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(input(seeded.source.id));
    const prepared = await step(definition, "prepare_source").run(ctx, {});

    await expect(step(definition, "build_images").run(ctx, { prepare_source: prepared }))
      .rejects.toThrow(/changed repository/);
    expect(transport.targets).toHaveLength(0);
  });

  test("rejects a committed manifest that changes the webhook branch", async () => {
    const seeded = fixture();
    const transport = inMemoryTransport({
      [MANIFEST_PATH]: JSON.stringify(manifest(seeded, { branch: "release" })),
    });
    const definition = createWebhookBuildSourceDefinition(transport);
    const ctx = context(input(seeded.source.id));
    const prepared = await step(definition, "prepare_source").run(ctx, {});

    await expect(step(definition, "build_images").run(ctx, { prepare_source: prepared }))
      .rejects.toThrow(/changed webhook branch/);
    expect(transport.targets).toHaveLength(0);
  });
});
