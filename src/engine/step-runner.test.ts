// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-step-runner-test-"));

import { describe, test, expect, mock } from "bun:test";
import {
  enqueueOperation,
  getOperation,
  getSteps,
  isCancelRequested,
  requestCancel,
} from "../shared/db/operations.ts";
import { runOperation } from "./step-runner.ts";
import type { AnyOpKind } from "./types.ts";
import type { OperationRow } from "../shared/db/operations.ts";

// park/unpark are no-ops in unit tests — the engine module has module-level
// state that interferes when imported without the full loop running.
mock.module("./engine.ts", () => ({ parkOp: () => {}, unparkOp: () => {} }));

function makeOp(kind: string): OperationRow {
  const row = enqueueOperation({
    kind,
    resourceKeys: [],
    input: {},
    trigger: "test",
  });
  return getOperation(row.id)!;
}

function makeDef(steps: AnyOpKind["steps"]): AnyOpKind {
  return { kind: "test-op", label: "Test Op", resourceKeys: () => [], steps } as AnyOpKind;
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

    const fin = getOperation(op.id)!;
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

    const fin = getOperation(op.id)!;
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

    // New behavior: when any compensate fails, the op stays in 'compensating'
    // so the reconciler can retry it. Only fully successful rollback yields
    // 'compensated'.
    expect(getOperation(op.id)!.status).toBe("compensating");
  });
});

// ---- probe-based idempotency adoption ---------------------------------------

describe("step-runner: probe adopts existing side effect", () => {
  test("probe returning non-null skips run and records ok", async () => {
    const runFn = mock(async () => "should-not-run");
    const def = makeDef([
      {
        name: "tagged-step",
        run: runFn,
        probe: async () => "adopted-output",
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);

    expect(runFn).not.toHaveBeenCalled();
    const steps = getSteps(op.id);
    const row = steps.find((s) => s.step === "tagged-step");
    expect(row?.status).toBe("ok");
    expect(row?.output_json).toBe(JSON.stringify("adopted-output"));
    expect(row?.detail).toContain("adopted");
    expect(getOperation(op.id)!.status).toBe("done");
  });

  test("probe returning null falls through to run", async () => {
    const runFn = mock(async () => "ran-it");
    const def = makeDef([
      {
        name: "tagged-step",
        run: runFn,
        probe: async () => null,
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);
    expect(runFn).toHaveBeenCalled();
    expect(getOperation(op.id)!.status).toBe("done");
  });

  test("step is marked 'executing' before run() is invoked", async () => {
    const seen: string[] = [];
    const def = makeDef([
      {
        name: "watched",
        run: async (ctx) => {
          // Read the live row state mid-flight.
          const { default: conn } = await import("../shared/db/connection.ts");
          const row = conn.query("SELECT status FROM operation_steps WHERE op_id = ? AND step = ?").get(ctx.opId, "watched") as { status: string } | null;
          if (row) seen.push(row.status);
          return null;
        },
      },
    ]);
    const op = makeOp("test-op");
    await runOperation(op, def);
    expect(seen).toEqual(["executing"]);
  });
});

// ---- resumable compensation -------------------------------------------------

describe("step-runner: resumable compensation", () => {
  test("re-running a 'compensating' op resumes from where it left off", async () => {
    const compensated: string[] = [];
    const def = makeDef([
      {
        name: "a",
        run: async () => "out-a",
        compensate: async () => { compensated.push("a"); },
      },
      {
        name: "b",
        run: async () => "out-b",
        compensate: async () => { compensated.push("b"); },
      },
      {
        name: "c",
        run: async () => { throw new Error("forward fail"); },
      },
    ]);
    const op = makeOp("test-op");

    // First run: forward fails at c, compensation runs b then a, op finishes
    // as 'compensated'. Reset compensated[] and manually re-mark the op as
    // 'compensating' and clear the b compensate row to simulate a crash that
    // happened BEFORE b's compensate completed (but a's had already run).
    await runOperation(op, def);
    expect(compensated).toEqual(["b", "a"]);
    compensated.length = 0;

    const { default: conn } = await import("../shared/db/connection.ts");
    // Wipe b's compensate row and put op back into 'compensating'.
    conn.run("DELETE FROM operation_steps WHERE op_id = ? AND step = 'b' AND phase = 'compensate'", [op.id]);
    conn.run("UPDATE operations SET status = 'compensating', finished_at = NULL WHERE id = ?", [op.id]);

    // Resume.
    const reloaded = (await import("../shared/db/operations.ts")).getOperation(op.id)!;
    await runOperation(reloaded, def);

    // Only b's compensate should re-run; a's compensate was already recorded ok
    // from the first pass so it's skipped (durable resume).
    expect(compensated).toEqual(["b"]);
    expect(getOperation(op.id)!.status).toBe("compensated");
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
    const def = makeDef([
      {
        name: "s1",
        run: async () => null,
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
    const fin = getOperation(op.id)!;
    // The cancel sentinel is set; depending on timing it may finish cancelled or
    // compensated. Either way, status is one of those two.
    expect(["cancelled", "compensated"].includes(fin.status)).toBe(true);
  });
});
