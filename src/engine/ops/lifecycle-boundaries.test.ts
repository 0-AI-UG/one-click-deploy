import { describe, expect, test } from "bun:test";
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import pauseAppOp from "./pause-app.ts";
import wakeOp from "./wake.ts";
import { appReplicaLifecycleOp } from "./app-lifecycle.ts";

function context(opId: number, kind: string, input: unknown) {
  return {
    opId,
    kind,
    input,
    trigger: "test",
    triggeredBy: "",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  } as any;
}

function readyServer() {
  const suffix = randomSuffix();
  return db.insertServer({
    name: `lifecycle-${suffix}`,
    provider_id: `provider-${suffix}`,
    ipv4: "192.0.2.44",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

describe("lifecycle operation boundaries", () => {
  test("app lifecycle fans out into idempotent per-replica child operations", async () => {
    const server = readyServer();
    const app = db.insertApp({
      name: `app-lifecycle-${randomSuffix()}`,
      domain: "",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
    });
    const replica = db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    const parent = enqueueOperation({
      kind: "pause_app",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "test",
    });
    const step = pauseAppOp.steps.find((candidate) => candidate.name === "pause_replicas")!;
    const prior = { check_precondition: { skip: false } };
    const first = await step.run(context(parent.id, parent.kind, { appId: app.id }), prior) as any;
    const replay = await step.run(context(parent.id, parent.kind, { appId: app.id }), prior) as any;

    expect(first.childIds).toEqual(replay.childIds);
    expect(listChildOperations(parent.id)).toHaveLength(1);
    expect(JSON.parse(listChildOperations(parent.id)[0]!.input_json)).toEqual({
      appId: app.id,
      replicaId: replica.id,
      action: "pause",
    });
    expect(appReplicaLifecycleOp.steps.map((candidate) => candidate.name)).toEqual([
      "load_replica",
      "apply_container_action",
      "verify_replica",
      "persist_replica_state",
    ]);
  });
});

describe("wake replay boundary", () => {
  test("uses an exact completion probe and keeps publication separate", () => {
    expect(wakeOp.steps.map((step) => step.name)).toEqual([
      "check_sleeping",
      "start_containers",
      "sync_ingress",
    ]);
    expect(wakeOp.steps.find((step) => step.name === "start_containers")?.probe).toBeFunction();
  });
});
