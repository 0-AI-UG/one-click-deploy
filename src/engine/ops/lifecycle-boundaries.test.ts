import { describe, expect, test } from "bun:test";
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import pauseAppOp from "./pause-app.ts";
import pauseServiceOp from "./pause-service.ts";
import repairServiceOp from "./repair-service.ts";
import wakeOp from "./wake.ts";
import { appReplicaLifecycleOp } from "./app-lifecycle.ts";
import { serviceInstanceLifecycleOp } from "./service-instances.ts";

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
      git_repo: "",
      dockerfile_path: "",
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

  test("service lifecycle fans out into idempotent per-instance child operations", async () => {
    const server = readyServer();
    const service = db.insertService({
      name: `service-lifecycle-${randomSuffix()}`,
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: "{}",
      credentials: "{}",
    });
    const instance = db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: service.name,
      host_port: 15000,
      status: "running",
    });
    const parent = enqueueOperation({
      kind: "pause_service",
      resourceKeys: [`service:${service.id}`],
      input: { serviceId: service.id },
      trigger: "test",
    });
    const step = pauseServiceOp.steps.find((candidate) => candidate.name === "pause_instances")!;
    const prior = { check_precondition: { skip: false } };
    const first = await step.run(context(parent.id, parent.kind, { serviceId: service.id }), prior) as any;
    const replay = await step.run(context(parent.id, parent.kind, { serviceId: service.id }), prior) as any;

    expect(first.childIds).toEqual(replay.childIds);
    expect(listChildOperations(parent.id)).toHaveLength(1);
    expect(JSON.parse(listChildOperations(parent.id)[0]!.input_json)).toEqual({
      serviceId: service.id,
      instanceId: instance.id,
      action: "pause",
    });
    expect(serviceInstanceLifecycleOp.steps.map((candidate) => candidate.name)).toEqual([
      "load_instance",
      "apply_container_action",
      "verify_instance",
      "persist_instance_state",
    ]);
  });
});

describe("repair service boundaries", () => {
  test("separates target, claim, attachment, readiness, placement, and cleanup", () => {
    expect(repairServiceOp.steps.map((step) => step.name)).toEqual([
      "select_repair_target",
      "inspect_volume",
      "mark_deploying",
      "reserve_target_port",
      "verify_target_port",
      "attach_volume",
      "ensure_volume_bind_mount",
      "converge_container",
      "verify_health",
      "commit_placement",
      "mark_running",
      "release_port_reservation",
      "gc_source_server",
    ]);
    expect(repairServiceOp.steps.find((step) => step.name === "attach_volume")?.probe).toBeFunction();
    expect(repairServiceOp.steps.find((step) => step.name === "commit_placement")?.compensate).toBeFunction();
  });

  test("persists unhealthy state before rejecting a failed readiness check", async () => {
    const server = readyServer();
    const service = db.insertService({
      name: `service-repair-${randomSuffix()}`,
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: "{}",
      credentials: "{}",
    });
    const instance = db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: service.name,
      host_port: 15000,
      status: "deploying",
    });
    db.updateServiceStatus(service.id, "deploying");
    const commit = repairServiceOp.steps.find((step) => step.name === "commit_placement")!;
    await expect(commit.run(
      context(999_001, "repair_service", { serviceId: service.id, instanceId: instance.id }),
      {
        select_repair_target: {
          sourceServerId: server.id,
          sourceHostPort: instance.host_port,
          targetServerId: server.id,
          moving: false,
        },
        reserve_target_port: { id: null, hostPort: instance.host_port },
        verify_health: { healthy: false, error: "not ready" },
      },
    )).rejects.toThrow("not ready");
    expect(db.getService(service.id)?.status).toBe("unhealthy");
    expect(db.getServiceInstance(instance.id)?.status).toBe("unhealthy");
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
