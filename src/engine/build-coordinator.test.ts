import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import connection from "../shared/db/connection.ts";
import { enqueueOperation } from "../shared/db/operations.ts";
import type { ServerRow } from "../shared/db/servers.ts";
import { createBuildCoordinator } from "./build-coordinator.ts";
import type { BuildTransport, WorkerObservation } from "./build-transport.ts";

const HEALTHY_DISK_BYTES = 30 * 1024 ** 3;

function operation() {
  return enqueueOperation({
    kind: "test_coordinated_build",
    resourceKeys: [],
    input: {},
    trigger: "test",
  });
}

function worker(name: string) {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `${name}-${suffix}`,
    provider_id: `${name}-${suffix}`,
    ipv4: "203.0.113.50",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const row = db.insertBuildWorker({
    serverId: server.id,
    name: `${name}-${suffix}`,
    previousPool: "general",
  });
  db.updateBuildWorker(row.id, {
    status: "online",
    disk_free_bytes: HEALTHY_DISK_BYTES,
    last_checked_at: new Date().toISOString(),
  });
  return { row: db.getBuildWorker(row.id)!, server };
}

function observation(overrides: Partial<WorkerObservation> = {}): WorkerObservation {
  return {
    online: true,
    version: "test",
    architecture: "x86_64",
    diskFreeBytes: HEALTHY_DISK_BYTES,
    error: "",
    ...overrides,
  };
}

function transport(observations: Map<number, WorkerObservation>): BuildTransport {
  return {
    probeWorker: async (server: ServerRow) => observations.get(server.id) ?? observation(),
    buildCommit: async () => ({ refs: new Map(), files: {} }),
    verifyArtifact: async () => true,
  };
}

beforeEach(() => {
  connection.query("DELETE FROM build_worker_leases").run();
  connection.query("DELETE FROM operations").run();
  connection.query("DELETE FROM build_sources").run();
  connection.query("DELETE FROM build_workers").run();
  connection.query("DELETE FROM servers").run();
});

describe("build coordinator", () => {
  test("selects the preferred compatible worker ahead of a roomier worker", async () => {
    const preferred = worker("preferred");
    const roomier = worker("roomier");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map([
      [preferred.server.id, observation({ diskFreeBytes: 20 * 1024 ** 3 })],
      [roomier.server.id, observation({ diskFreeBytes: 80 * 1024 ** 3 })],
    ])));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result).toEqual({ value: preferred.row.id, workerId: preferred.row.id });
  });

  test("fails over when the preferred worker is offline", async () => {
    const preferred = worker("offline-preferred");
    const fallback = worker("online-fallback");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map([
      [preferred.server.id, observation({ online: false, error: "unreachable" })],
      [fallback.server.id, observation()],
    ])));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result.workerId).toBe(fallback.row.id);
    expect(db.getBuildWorker(preferred.row.id)?.status).toBe("offline");
  });

  test("holds a durable lease during the callback and releases it after success", async () => {
    const candidate = worker("success-lease");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    const result = await coordinator.withWorker({
      operationId: op.id,
      run: async (selection) => {
        const lease = db.getBuildWorkerLeaseForOperation(op.id);
        expect(lease?.worker_id).toBe(candidate.row.id);
        expect(db.getActiveBuildWorkerLease(candidate.row.id)?.operation_id).toBe(op.id);
        return "built";
      },
    });

    expect(result).toEqual({ value: "built", workerId: candidate.row.id });
    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
  });

  test("releases the durable lease when the callback fails", async () => {
    const candidate = worker("failure-lease");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    await expect(coordinator.withWorker({
      operationId: op.id,
      run: async () => {
        expect(db.getBuildWorkerLeaseForOperation(op.id)?.worker_id).toBe(candidate.row.id);
        throw new Error("build failed");
      },
    })).rejects.toThrow("build failed");

    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
  });

  test("falls back when the preferred worker slot is already leased", async () => {
    const preferred = worker("busy-preferred");
    const fallback = worker("idle-fallback");
    const occupyingOp = operation();
    const op = operation();
    const occupied = db.tryAcquireBuildWorkerLease({
      operationId: occupyingOp.id,
      candidateWorkerIds: [preferred.row.id],
    });
    expect(occupied?.worker_id).toBe(preferred.row.id);
    const coordinator = createBuildCoordinator(transport(new Map()));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result.workerId).toBe(fallback.row.id);
    expect(db.getBuildWorkerLeaseForOperation(occupyingOp.id)?.lease_token).toBe(occupied?.lease_token);
  });

  test.each([
    ["changed", (operationId: number) => {
      connection.query("UPDATE build_worker_leases SET lease_token = ? WHERE operation_id = ?")
        .run(crypto.randomUUID(), operationId);
    }],
    ["deleted", (operationId: number) => {
      connection.query("DELETE FROM build_worker_leases WHERE operation_id = ?").run(operationId);
    }],
  ] as const)("rejects a callback result when its lease token is %s", async (_case, fenceLease) => {
    worker(`fenced-${_case}`);
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    await expect(coordinator.withWorker({
      operationId: op.id,
      run: async () => {
        fenceLease(op.id);
        return "must-not-publish";
      },
    })).rejects.toThrow("Build worker lease was lost before publication could be committed");
  });
});
