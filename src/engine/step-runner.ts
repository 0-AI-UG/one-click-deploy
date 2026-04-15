import {
  getCompletedForwardSteps,
  insertStep,
  finishStep,
  nextStepSeq,
  updateLastStep,
  isCancelRequested,
  markOperationCompensating,
  markOperationFinished,
  markOperationRunning,
} from "../shared/db/operations.ts";
import type { AnyOpKind, OpContext, Step } from "./types.ts";
import type { OperationRow } from "../shared/db/operations.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:step-runner]`, ...args);
}

class CancelledError extends Error {
  constructor() {
    super("operation cancelled");
  }
}

/**
 * Execute an op end-to-end: mark running, replay prior successful steps (skip),
 * run remaining steps, on failure run compensations in reverse for steps that
 * actually completed in this or prior attempts.
 */
export async function runOperation(op: OperationRow, def: AnyOpKind): Promise<void> {
  markOperationRunning(op.id);
  const input = JSON.parse(op.input_json || "{}");
  const ctx: OpContext = {
    opId: op.id,
    kind: op.kind,
    input,
    trigger: op.trigger,
    triggeredBy: op.triggered_by,
    parentId: op.parent_id,
    attempt: op.attempt + 1,
    isCancelRequested: () => isCancelRequested(op.id),
    log: (line) => log(`op#${op.id}`, line),
  };

  // Prior completed forward steps (from earlier attempt) are replayed as skips.
  const completed = getCompletedForwardSteps(op.id);
  const priorByName = new Map<string, unknown>();
  for (const row of completed) {
    priorByName.set(row.step, row.output_json ? JSON.parse(row.output_json) : null);
  }
  // Track steps completed in this run (for in-attempt compensation).
  const completedThisRun: Array<{ step: Step; output: unknown }> = [];
  const priorOutputs: Record<string, unknown> = Object.fromEntries(priorByName);

  try {
    for (const step of def.steps) {
      if (ctx.isCancelRequested()) throw new CancelledError();

      if (priorByName.has(step.name)) {
        // Resume: step already succeeded in a prior attempt. Record a skip row.
        const seq = nextStepSeq(op.id);
        insertStep({
          opId: op.id,
          seq,
          step: step.name,
          phase: "forward",
          status: "skipped",
          detail: "resumed from prior attempt",
          outputJson: JSON.stringify(priorByName.get(step.name) ?? null),
        });
        continue;
      }

      const seq = nextStepSeq(op.id);
      updateLastStep(op.id, step.name);
      insertStep({
        opId: op.id,
        seq,
        step: step.name,
        phase: "forward",
        status: "started",
      });

      try {
        const out = await step.run(ctx, priorOutputs);
        finishStep({
          opId: op.id,
          seq,
          status: "ok",
          outputJson: JSON.stringify(out ?? null),
        });
        priorOutputs[step.name] = out;
        completedThisRun.push({ step, output: out });
      } catch (err) {
        finishStep({
          opId: op.id,
          seq,
          status: "failed",
          detail: errMsg(err),
        });
        throw err;
      }
    }

    markOperationFinished(op.id, "done");
  } catch (err) {
    const cancelled = err instanceof CancelledError || ctx.isCancelRequested();
    log(`op#${op.id} failed`, errMsg(err), cancelled ? "(cancelled)" : "");
    markOperationCompensating(op.id, { message: errMsg(err), cancelled });

    // Compensate in reverse: all completed forward steps (prior + this run)
    // that have a compensate fn. Walk def.steps in reverse so order is correct.
    await runCompensations(op, def, priorOutputs);

    markOperationFinished(
      op.id,
      cancelled ? "cancelled" : "compensated",
      { message: errMsg(err), cancelled },
    );
  }
}

async function runCompensations(
  op: OperationRow,
  def: AnyOpKind,
  priorOutputs: Record<string, unknown>,
): Promise<void> {
  const completed = new Set(
    getCompletedForwardSteps(op.id).map((r) => r.step),
  );
  for (let i = def.steps.length - 1; i >= 0; i--) {
    const step = def.steps[i];
    if (!step.compensate) continue;
    if (!completed.has(step.name)) continue;
    const out = priorOutputs[step.name];
    const seq = nextStepSeq(op.id);
    insertStep({
      opId: op.id,
      seq,
      step: step.name,
      phase: "compensate",
      status: "started",
    });
    try {
      await step.compensate({
        opId: op.id,
        kind: op.kind,
        input: JSON.parse(op.input_json || "{}"),
        trigger: op.trigger,
        triggeredBy: op.triggered_by,
        parentId: op.parent_id,
        attempt: op.attempt,
        isCancelRequested: () => false, // don't short-circuit compensations
        log: (line) => log(`op#${op.id} (compensate)`, line),
      }, out, priorOutputs);
      finishStep({ opId: op.id, seq, status: "ok" });
    } catch (err) {
      finishStep({
        opId: op.id,
        seq,
        status: "failed",
        detail: errMsg(err),
      });
      log(`op#${op.id} compensate step ${step.name} failed:`, errMsg(err));
      // continue compensating the rest — best effort
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
