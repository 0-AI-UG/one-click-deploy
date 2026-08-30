import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import connection from "./connection.ts";
import { enqueueOperation, markOperationFinished } from "./operations.ts";

function operation() {
  return enqueueOperation({
    kind: "test_build",
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
    ipv4: "203.0.113.40",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const row = db.insertBuildWorker({ serverId: server.id, name: `${name}-${suffix}`, previousPool: "general" });
  db.updateBuildWorker(row.id, {
    status: "online",
    disk_free_bytes: 30 * 1024 ** 3,
    last_checked_at: new Date().toISOString(),
  });
  return db.getBuildWorker(row.id)!;
}

describe("durable build-worker leases", () => {
  test("serializes one slot and releases it for the next operation", () => {
    const candidate = worker("serialize");
    const firstOp = operation();
    const secondOp = operation();
    const first = db.tryAcquireBuildWorkerLease({ operationId: firstOp.id, candidateWorkerIds: [candidate.id] });
    expect(first?.worker_id).toBe(candidate.id);
    expect(db.tryAcquireBuildWorkerLease({ operationId: secondOp.id, candidateWorkerIds: [candidate.id] })).toBeNull();
    expect(db.releaseBuildWorkerLease({ operationId: firstOp.id, leaseToken: first!.lease_token })).toBe(true);
    expect(db.tryAcquireBuildWorkerLease({ operationId: secondOp.id, candidateWorkerIds: [candidate.id] })?.worker_id)
      .toBe(candidate.id);
  });

  test("reacquires idempotently and rejects a stale token", () => {
    const candidate = worker("idempotent");
    const op = operation();
    const first = db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [candidate.id] })!;
    const second = db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [candidate.id] })!;
    expect(second.lease_token).toBe(first.lease_token);
    expect(db.heartbeatBuildWorkerLease({ operationId: op.id, leaseToken: "wrong" })).toBe(false);
    expect(db.releaseBuildWorkerLease({ operationId: op.id, leaseToken: "wrong" })).toBe(false);
    expect(db.releaseBuildWorkerLease({ operationId: op.id, leaseToken: first.lease_token })).toBe(true);
  });

  test("reclaims an expired claim and fences its former owner", () => {
    const candidate = worker("expired");
    const firstOp = operation();
    const secondOp = operation();
    const first = db.tryAcquireBuildWorkerLease({ operationId: firstOp.id, candidateWorkerIds: [candidate.id] })!;
    connection.query("UPDATE build_worker_leases SET expires_at = datetime('now', '-1 second') WHERE operation_id = ?")
      .run(firstOp.id);
    const second = db.tryAcquireBuildWorkerLease({ operationId: secondOp.id, candidateWorkerIds: [candidate.id] })!;
    expect(second.operation_id).toBe(secondOp.id);
    expect(db.heartbeatBuildWorkerLease({ operationId: firstOp.id, leaseToken: first.lease_token })).toBe(false);
    expect(db.releaseBuildWorkerLease({ operationId: firstOp.id, leaseToken: first.lease_token })).toBe(false);
  });

  test("excludes draining, stale, and low-disk workers", () => {
    const draining = worker("draining");
    const lowDisk = worker("low-disk");
    const stale = worker("stale");
    db.updateBuildWorker(draining.id, { draining: 1 });
    db.updateBuildWorker(lowDisk.id, { disk_free_bytes: 1024 });
    db.updateBuildWorker(stale.id, { last_checked_at: "2000-01-01T00:00:00.000Z" });
    const op = operation();
    expect(db.tryAcquireBuildWorkerLease({
      operationId: op.id,
      candidateWorkerIds: [draining.id, lowDisk.id, stale.id],
    })).toBeNull();
  });

  test("reaps claims owned by terminal operations", () => {
    const candidate = worker("terminal");
    const op = operation();
    const lease = db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [candidate.id] })!;
    markOperationFinished(op.id, "done");
    expect(db.reapTerminalBuildWorkerLeases()).toBe(1);
    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
    expect(db.releaseBuildWorkerLease({ operationId: op.id, leaseToken: lease.lease_token })).toBe(false);
  });
});
