import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import {
  tryAcquireResourceLock,
  releaseResourceLocks,
  releaseEngineResourceLocks,
  getResourceLockHolder,
  registerEngine,
  removeEngine,
  getLiveEngines,
  removeStaleEngines,
} from "../shared/db/orgs.ts";
import { enqueueOperation, claimOperation, resetStaleOperations, getOperationUnscoped } from "../shared/db/operations.ts";
import * as dbOrgs from "../shared/db/orgs.ts";

try { dbOrgs.insertOrg("sched-org", "Sched Org", "sched-org"); } catch {}

// ---- resource lock acquisition -----------------------------------------------

describe("scheduler: resource locks", () => {
  test("tryAcquireResourceLock returns true for a fresh key", () => {
    const key = `res-${Date.now()}-a`;
    expect(tryAcquireResourceLock(key, "engine-1", 1001)).toBe(true);
    releaseResourceLocks(1001);
  });

  test("second acquire on same key returns false", () => {
    const key = `res-${Date.now()}-b`;
    expect(tryAcquireResourceLock(key, "engine-1", 2001)).toBe(true);
    expect(tryAcquireResourceLock(key, "engine-2", 2002)).toBe(false);
    releaseResourceLocks(2001);
  });

  test("after release the key can be re-acquired", () => {
    const key = `res-${Date.now()}-c`;
    expect(tryAcquireResourceLock(key, "engine-1", 3001)).toBe(true);
    releaseResourceLocks(3001);
    expect(tryAcquireResourceLock(key, "engine-2", 3002)).toBe(true);
    releaseResourceLocks(3002);
  });

  test("getResourceLockHolder reflects the current holder", () => {
    const key = `res-${Date.now()}-d`;
    tryAcquireResourceLock(key, "engine-x", 4001);
    const holder = getResourceLockHolder(key);
    expect(holder?.engine_id).toBe("engine-x");
    expect(holder?.op_id).toBe(4001);
    releaseResourceLocks(4001);
  });
});

// ---- overlapping vs disjoint keys --------------------------------------------

describe("scheduler: overlapping resource_keys serialize", () => {
  test("two ops with overlapping keys: second cannot acquire while first holds", () => {
    const sharedKey = `overlap-${Date.now()}`;
    const op1 = enqueueOperation({ kind: "noop", resourceKeys: [sharedKey], input: {}, trigger: "test", orgId: "sched-org" });
    const op2 = enqueueOperation({ kind: "noop", resourceKeys: [sharedKey], input: {}, trigger: "test", orgId: "sched-org" });

    const got1 = tryAcquireResourceLock(sharedKey, "engine-1", op1.id);
    const got2 = tryAcquireResourceLock(sharedKey, "engine-1", op2.id);

    expect(got1).toBe(true);
    expect(got2).toBe(false);

    releaseResourceLocks(op1.id);
    // Now op2 can acquire.
    expect(tryAcquireResourceLock(sharedKey, "engine-1", op2.id)).toBe(true);
    releaseResourceLocks(op2.id);
  });

  test("disjoint keys: both ops can acquire concurrently", () => {
    const keyA = `disjoint-a-${Date.now()}`;
    const keyB = `disjoint-b-${Date.now()}`;
    const op1 = enqueueOperation({ kind: "noop", resourceKeys: [keyA], input: {}, trigger: "test", orgId: "sched-org" });
    const op2 = enqueueOperation({ kind: "noop", resourceKeys: [keyB], input: {}, trigger: "test", orgId: "sched-org" });

    const got1 = tryAcquireResourceLock(keyA, "engine-1", op1.id);
    const got2 = tryAcquireResourceLock(keyB, "engine-1", op2.id);

    expect(got1).toBe(true);
    expect(got2).toBe(true);

    releaseResourceLocks(op1.id);
    releaseResourceLocks(op2.id);
  });
});

// ---- crashed engine cleanup --------------------------------------------------

describe("scheduler: crashed engine cleanup", () => {
  test("releaseEngineResourceLocks releases all locks held by an engine", () => {
    const key1 = `crash-key-1-${Date.now()}`;
    const key2 = `crash-key-2-${Date.now()}`;
    tryAcquireResourceLock(key1, "dead-engine", 5001);
    tryAcquireResourceLock(key2, "dead-engine", 5002);

    expect(getResourceLockHolder(key1)?.engine_id).toBe("dead-engine");
    expect(getResourceLockHolder(key2)?.engine_id).toBe("dead-engine");

    releaseEngineResourceLocks("dead-engine");

    expect(getResourceLockHolder(key1)).toBeNull();
    expect(getResourceLockHolder(key2)).toBeNull();
  });

  test("removeStaleEngines removes heartbeat and getLiveEngines excludes it", () => {
    const engineId = `stale-eng-${Date.now()}`;
    registerEngine(engineId);
    // Manually backdate the heartbeat so it appears stale.
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE engine_instances SET heartbeat_at = datetime('now', '-120 seconds') WHERE id = ?", [engineId]);

    const staleIds = removeStaleEngines(30);
    expect(staleIds).toContain(engineId);
    expect(getLiveEngines(30).map((e) => e.id)).not.toContain(engineId);
  });

  test("resetStaleOperations re-pends claimed-but-dead ops", () => {
    const op = enqueueOperation({ kind: "noop", resourceKeys: [], input: {}, trigger: "test", orgId: "sched-org" });
    claimOperation(op.id, "dying-engine");
    expect(getOperationUnscoped(op.id)!.status).toBe("running");

    resetStaleOperations("dying-engine");
    expect(getOperationUnscoped(op.id)!.status).toBe("pending");
  });
});

// ---- engine heartbeat / registration -----------------------------------------

describe("scheduler: engine registration", () => {
  test("registerEngine + getLiveEngines shows engine as live", () => {
    const id = `eng-live-${Date.now()}`;
    registerEngine(id);
    const live = getLiveEngines(30);
    expect(live.some((e) => e.id === id)).toBe(true);
    removeEngine(id);
  });

  test("removeEngine removes it from live list", () => {
    const id = `eng-rm-${Date.now()}`;
    registerEngine(id);
    removeEngine(id);
    const live = getLiveEngines(30);
    expect(live.some((e) => e.id === id)).toBe(false);
  });
});
