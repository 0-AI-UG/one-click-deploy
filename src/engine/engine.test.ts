// Tests for engine orchestration: claim races, stale cleanup, and
// concurrency behaviors at the DB level. The engine's module-level loop
// state (inFlight, stopping, etc.) is tested indirectly — we drive the
// underlying DB primitives directly and verify invariants.
import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";
import {
  enqueueOperation,
  claimOperation,
  resetStaleOperations,
  getOperationUnscoped,
  listPendingOperations,
  listRunningOperations,
  markOperationFinished,
} from "../shared/db/operations.ts";
import {
  tryAcquireResourceLock,
  releaseResourceLocks,
  registerEngine,
  removeEngine,
  updateEngineHeartbeat,
  getLiveEngines,
  removeStaleEngines,
  releaseEngineResourceLocks,
  insertOrg,
} from "../shared/db/orgs.ts";
import { registerOp } from "./ops/registry.ts";

try { insertOrg("eng-org", "Engine Org", "eng-org"); } catch {}

// Register a fast no-op op kind for tests that spin up the engine loop.
try {
  registerOp({
    kind: "fast-noop",
    label: "Fast Noop",
    resourceKeys: () => [],
    steps: [{ name: "noop", run: async () => null }],
  });
} catch {}

function enqueue(resourceKeys: string[] = []) {
  return enqueueOperation({ kind: "fast-noop", resourceKeys, input: {}, trigger: "test", orgId: "eng-org" });
}

// ---- atomic claim race -------------------------------------------------------

describe("engine: atomic claim race", () => {
  test("exactly one winner when two callers race for one pending op", () => {
    const op = enqueue();

    // Two engines try to claim the same op atomically.
    const win1 = claimOperation(op.id, "engine-A");
    const win2 = claimOperation(op.id, "engine-B");

    // Exactly one must succeed.
    const wins = [win1, win2].filter(Boolean);
    expect(wins.length).toBe(1);

    // The row reflects whoever won.
    const row = getOperationUnscoped(op.id)!;
    expect(row.status).toBe("running");
    expect(["engine-A", "engine-B"]).toContain(row.claimed_by);
  });

  test("claimOperation returns false for already-running op", () => {
    const op = enqueue();
    expect(claimOperation(op.id, "engine-A")).toBe(true);
    expect(claimOperation(op.id, "engine-B")).toBe(false);
  });
});

// ---- stale cleanup re-pends claimed-but-dead ops ----------------------------

describe("engine: stale cleanup", () => {
  test("resetStaleOperations re-pends ops claimed by a dead engine", () => {
    const op = enqueue();
    claimOperation(op.id, "zombie-engine");
    expect(getOperationUnscoped(op.id)!.status).toBe("running");

    resetStaleOperations("zombie-engine");
    const refreshed = getOperationUnscoped(op.id)!;
    expect(refreshed.status).toBe("pending");
    expect(refreshed.claimed_by).toBe("");
  });

  test("resetStaleOperations does not affect ops claimed by other engines", () => {
    const op = enqueue();
    claimOperation(op.id, "live-engine");

    resetStaleOperations("other-dead-engine");
    // Still running under live-engine.
    expect(getOperationUnscoped(op.id)!.status).toBe("running");
  });
});

// ---- resource lock: serialization -------------------------------------------

describe("engine: resource lock serialization", () => {
  test("second op with overlapping key is blocked until first releases", () => {
    const key = `eng-lock-${Date.now()}`;
    const op1 = enqueue([key]);
    const op2 = enqueue([key]);

    // Engine-A picks up op1.
    const lockOk1 = tryAcquireResourceLock(key, "engine-A", op1.id);
    expect(lockOk1).toBe(true);

    // Engine-A tries op2 — blocked.
    const lockOk2 = tryAcquireResourceLock(key, "engine-A", op2.id);
    expect(lockOk2).toBe(false);

    // op1 finishes; op2 can now be picked up.
    releaseResourceLocks(op1.id);
    expect(tryAcquireResourceLock(key, "engine-A", op2.id)).toBe(true);
    releaseResourceLocks(op2.id);
  });

  test("disjoint resource keys allow concurrent execution", () => {
    const key1 = `eng-kA-${Date.now()}`;
    const key2 = `eng-kB-${Date.now()}`;
    const op1 = enqueue([key1]);
    const op2 = enqueue([key2]);

    expect(tryAcquireResourceLock(key1, "engine-A", op1.id)).toBe(true);
    expect(tryAcquireResourceLock(key2, "engine-A", op2.id)).toBe(true);

    releaseResourceLocks(op1.id);
    releaseResourceLocks(op2.id);
  });
});

// ---- unknown op kind (DB level) ----------------------------------------------

describe("engine: unknown op kind (DB level)", () => {
  test("markOperationFinished correctly sets status=failed with error_json", () => {
    const op = enqueueOperation({
      kind: "totally-unknown-kind",
      resourceKeys: [],
      input: {},
      trigger: "test",
      orgId: "eng-org",
    });
    markOperationFinished(op.id, "failed", { message: "unknown op kind 'totally-unknown-kind'" });
    const row = getOperationUnscoped(op.id)!;
    expect(row.status).toBe("failed");
    const err = JSON.parse(row.error_json!);
    expect(err.message).toMatch(/unknown op kind/i);
  });
});

// ---- leader election ---------------------------------------------------------

describe("engine: leader election", () => {
  test("isLeaderEngine returns true for the lowest-id live engine", () => {
    const { isLeaderEngine } = require("../shared/db/orgs.ts");
    const idA = `leader-a-${Date.now()}`;
    const idB = `leader-b-${Date.now() + 1}`;
    registerEngine(idA);
    registerEngine(idB);

    // Alphabetically idA < idB — getLiveEngines orders by id ASC.
    expect(isLeaderEngine(idA, 30)).toBe(true);
    expect(isLeaderEngine(idB, 30)).toBe(false);

    removeEngine(idA);
    // After idA removed, idB becomes leader.
    expect(isLeaderEngine(idB, 30)).toBe(true);

    removeEngine(idB);
  });

  test("stale engine is not counted as leader", () => {
    const { isLeaderEngine } = require("../shared/db/orgs.ts");
    const id = `stale-leader-${Date.now()}`;
    registerEngine(id);
    // Backdate heartbeat so it's stale.
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE engine_instances SET heartbeat_at = datetime('now', '-120 seconds') WHERE id = ?", [id]);

    expect(isLeaderEngine(id, 30)).toBe(false);

    removeStaleEngines(30);
  });
});
