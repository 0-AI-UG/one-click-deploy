// Tests for engine orchestration. The engine's module-level loop state
// (inFlight, stopping, etc.) is tested indirectly — we drive the underlying
// DB primitives + scheduler directly and verify invariants.
//
// Single-tenant: this branch has no per-org claim/lock DB tables. Resource
// serialization is in-memory (see scheduler.ts) and is exercised in
// scheduler.test.ts.
// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-engine-test-"));

import { describe, test, expect } from "bun:test";
import {
  enqueueOperation,
  getOperation,
  listPendingOperations,
  listRunningOperations,
  markOperationFinished,
  markOperationRunning,
} from "../shared/db/operations.ts";
import { registerOp } from "./ops/registry.ts";
import { tryAcquire, release } from "./scheduler.ts";

// Register a fast no-op op kind for tests.
try {
  registerOp({
    kind: "fast-noop",
    label: "Fast Noop",
    resourceKeys: () => [],
    steps: [{ name: "noop", run: async () => null }],
  });
} catch {}

function enqueue(resourceKeys: string[] = []) {
  return enqueueOperation({ kind: "fast-noop", resourceKeys, input: {}, trigger: "test" });
}

// ---- pending / running listings ---------------------------------------------

describe("engine: pending/running listings", () => {
  test("a freshly-enqueued op is pending and shows up in listPendingOperations", () => {
    const op = enqueue();
    const pending = listPendingOperations(50);
    expect(pending.some((p) => p.id === op.id)).toBe(true);
    const row = getOperation(op.id)!;
    expect(row.status).toBe("pending");
  });

  test("markOperationRunning moves the op into the running list", () => {
    const op = enqueue();
    markOperationRunning(op.id);
    expect(getOperation(op.id)!.status).toBe("running");
    expect(listRunningOperations().some((r) => r.id === op.id)).toBe(true);
  });
});

// ---- resource lock serialization (in-memory) --------------------------------

describe("engine: resource lock serialization", () => {
  test("second op with overlapping key is blocked until first releases", () => {
    const key = `eng-lock-${Date.now()}`;
    const op1 = enqueue([key]);
    const op2 = enqueue([key]);

    expect(tryAcquire([key], op1.id, "fast-noop").ok).toBe(true);
    expect(tryAcquire([key], op2.id, "fast-noop").ok).toBe(false);

    release([key]);
    expect(tryAcquire([key], op2.id, "fast-noop").ok).toBe(true);
    release([key]);
  });

  test("disjoint resource keys allow concurrent execution", () => {
    const key1 = `eng-kA-${Date.now()}`;
    const key2 = `eng-kB-${Date.now()}`;
    const op1 = enqueue([key1]);
    const op2 = enqueue([key2]);

    expect(tryAcquire([key1], op1.id, "fast-noop").ok).toBe(true);
    expect(tryAcquire([key2], op2.id, "fast-noop").ok).toBe(true);
    release([key1]);
    release([key2]);
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
    });
    markOperationFinished(op.id, "failed", { message: "unknown op kind 'totally-unknown-kind'" });
    const row = getOperation(op.id)!;
    expect(row.status).toBe("failed");
    const err = JSON.parse(row.error_json!);
    expect(err.message).toMatch(/unknown op kind/i);
  });
});
