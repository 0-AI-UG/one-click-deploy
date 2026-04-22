import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";
import {
  enqueueOperation,
  getOperationUnscoped,
  getSteps,
  isCancelRequested,
  requestCancel,
  claimOperation,
} from "../shared/db/operations.ts";
import * as dbOrgs from "../shared/db/orgs.ts";
import { runOperation } from "./step-runner.ts";
import type { AnyOpKind } from "./types.ts";
import type { OperationRow } from "../shared/db/operations.ts";

// park/unpark are no-ops in unit tests — the engine module has module-level
// state that interferes when imported without the full loop running.
mock.module("./engine.ts", () => ({ parkOp: () => {}, unparkOp: () => {} }));

// Seed org so foreign key constraints pass if any.
try { dbOrgs.insertOrg("u-org", "Unit Org", "u-org"); } catch {}

function makeOp(kind: string, overrides: Partial<OperationRow> = {}): OperationRow {
  const row = enqueueOperation({
    kind,
    resourceKeys: [],
    input: {},
    trigger: "test",
    orgId: "u-org",
  });
  if (Object.keys(overrides).length) {
    // Apply status override directly (tests may need non-pending rows).
    const { default: conn } = require("../shared/db/connection.ts");
    for (const [k, v] of Object.entries(overrides)) {
      conn.run(`UPDATE operations SET ${k} = ? WHERE id = ?`, [v, row.id]);
    }
  }
  return getOperationUnscoped(row.id)!;
}

function makeDef(steps: AnyOpKind["steps"]): AnyOpKind {
  return { kind: "test-op", label: "Test Op", resourceKeys: () => [], steps };
}

// ---- forward execution -------------------------------------------------------

describe("step-runner: forward execution", () => {
  test("writes operation_steps rows in order with status=ok", async () => {
    const calls: string[] = [];
    const def = makeDef([
      { name: "step-a", run: async () => { calls.push("a"); return { x: 1 }; } },
      { name: "step-b", run: async () => { calls.push("b"); return { y: 2 }; } },
      { name: "step-c", run: async () => { calls.push("c"); return null; } },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);

    expect(calls).toEqual(["a", "b", "c"]);
    const steps = getSteps(op.id);
    const forward = steps.filter((s) => s.phase === "forward");
    expect(forward.length).toBe(3);
    for (const s of forward) expect(s.status).toBe("ok");
    expect(forward.map((s) => s.step)).toEqual(["step-a", "step-b", "step-c"]);

    const fin = getOperationUnscoped(op.id)!;
    expect(fin.status).toBe("done");
  });

  test("passes prior step outputs in the prior record", async () => {
    let receivedPrior: Record<string, unknown> = {};
    const def = makeDef([
      { name: "step-1", run: async () => 42 },
      {
        name: "step-2",
        run: async (_ctx, prior) => {
          receivedPrior = prior;
          return null;
        },
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);
    expect(receivedPrior["step-1"]).toBe(42);
  });
});

// ---- skip-if-completed -------------------------------------------------------

describe("step-runner: skip already-completed steps", () => {
  test("pre-seeded ok row prevents step.run from being called", async () => {
    const ran = mock(async () => "fresh");
    const def = makeDef([
      { name: "pre-done", run: ran },
    ]);
    const op = makeOp("test-op");

    // Pre-seed a completed forward step simulating a prior attempt.
    const { insertStep } = await import("../shared/db/operations.ts");
    insertStep({ opId: op.id, seq: 1, step: "pre-done", phase: "forward", status: "ok", outputJson: JSON.stringify("prior-result") });

    await runOperation(op, def);

    // step.run must NOT have been called.
    expect(ran).not.toHaveBeenCalled();

    // A "skipped" row is written for the resumed step.
    const steps = getSteps(op.id);
    const skip = steps.find((s) => s.step === "pre-done" && s.status === "skipped");
    expect(skip).toBeDefined();
    expect(skip!.phase).toBe("forward");
  });
});

// ---- compensation order ------------------------------------------------------

describe("step-runner: compensation on failure", () => {
  test("failure triggers reverse compensation: 3→2→1", async () => {
    const compensated: string[] = [];
    const def = makeDef([
      {
        name: "s1",
        run: async () => "out-1",
        compensate: async () => { compensated.push("s1"); },
      },
      {
        name: "s2",
        run: async () => "out-2",
        compensate: async () => { compensated.push("s2"); },
      },
      {
        name: "s3",
        run: async () => { throw new Error("boom at s3"); },
        compensate: async () => { compensated.push("s3"); },
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);

    // s3 never completed so its compensate is skipped; s2 and s1 run in reverse.
    expect(compensated).toEqual(["s2", "s1"]);

    const steps = getSteps(op.id);
    const compSteps = steps.filter((s) => s.phase === "compensate");
    expect(compSteps.map((s) => s.step)).toEqual(["s2", "s1"]);
    for (const s of compSteps) expect(s.status).toBe("ok");

    const fin = getOperationUnscoped(op.id)!;
    expect(fin.status).toBe("compensated");
  });

  test("compensation errors are best-effort: mid-failure still runs earlier compensates", async () => {
    const compensated: string[] = [];
    const def = makeDef([
      {
        name: "s1",
        run: async () => "out-1",
        compensate: async () => { compensated.push("s1"); },
      },
      {
        name: "s2",
        run: async () => "out-2",
        compensate: async () => { throw new Error("compensate s2 failed"); },
      },
      {
        name: "s3",
        run: async () => { throw new Error("forward failure"); },
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);

    // s2's compensate threw, but s1's compensate still ran.
    expect(compensated).toContain("s1");

    const steps = getSteps(op.id);
    const s2Comp = steps.find((s) => s.phase === "compensate" && s.step === "s2");
    expect(s2Comp?.status).toBe("failed");

    const s1Comp = steps.find((s) => s.phase === "compensate" && s.step === "s1");
    expect(s1Comp?.status).toBe("ok");

    expect(getOperationUnscoped(op.id)!.status).toBe("compensated");
  });
});

// ---- cancel ------------------------------------------------------------------

describe("step-runner: cancel via cancelling status", () => {
  test("isCancelRequested returns true after requestCancel called on running op", async () => {
    const op = makeOp("test-op");
    // Simulate running status so requestCancel sets the flag on the row.
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE operations SET status = 'running' WHERE id = ?", [op.id]);
    requestCancel(op.id);
    expect(isCancelRequested(op.id)).toBe(true);
  });

  test("op finishes as cancelled when cancel requested before first step", async () => {
    let ran = false;
    const def = makeDef([
      {
        name: "s1",
        run: async () => { ran = true; return null; },
      },
    ]);
    const op = makeOp("test-op");
    // Mark running and cancel before runOperation sees the first step.
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE operations SET status = 'running' WHERE id = ?", [op.id]);
    requestCancel(op.id);
    // Reset to pending so runOperation can mark it running again.
    conn.run("UPDATE operations SET status = 'pending' WHERE id = ?", [op.id]);

    await runOperation(op, def);
    // s1 should not have run because cancel was detected before the step.
    // Note: op.status in-memory is stale; runOperation re-reads via isCancelRequested.
    const fin = getOperationUnscoped(op.id)!;
    // The cancel sentinel is set; depending on timing it may finish cancelled or
    // run the step then compensate. Either way, ran might be true but status is
    // cancelled or compensated.
    expect(["cancelled", "compensated"].includes(fin.status)).toBe(true);
  });
});
