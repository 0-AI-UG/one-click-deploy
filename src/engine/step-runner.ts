import {
  getCompletedForwardSteps,
  getCompletedCompensateSteps,
  insertStep,
  finishStep,
  nextStepSeq,
  updateLastStep,
  markStepExecuting,
  isCancelRequested,
  markOperationCompensating,
  markOperationFinished,
  markOperationRunning,
  bumpAttempt,
  findSupersedingOperation,
  findSupersedingAncestorOperation,
} from "../shared/db/operations.ts";
import type { AnyOpKind, OpContext, Step } from "./types.ts";
import type { OperationRow } from "../shared/db/operations.ts";
import { parkOp, unparkOp } from "./engine.ts";
import { withOpContext } from "./op-logger.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:step-runner]`, ...args);
}

class CancelledError extends Error {
  constructor() {
    super("operation cancelled");
  }
}

function buildContext(op: OperationRow, input: unknown, phase: "forward" | "compensate"): OpContext {
  const label = phase === "compensate" ? "(compensate)" : "";
  return {
    opId: op.id,
    kind: op.kind,
    input,
    trigger: op.trigger,
    triggeredBy: op.triggered_by,
    parentId: op.parent_id,
    attempt: op.attempt + 1,
    // Compensations must not short-circuit on cancel.
    isCancelRequested: () => (phase === "forward" ? isCancelRequested(op.id) : false),
    log: (line) => log(`op#${op.id}${label ? ` ${label}` : ""}`, line),
    park: () => parkOp(op.id),
    unpark: () => unparkOp(op.id),
  };
}

/**
 * Execute an op end-to-end:
 *   - mark running, replay prior 'ok'/'skipped' forward steps as skips
 *   - for each new step: probe (adopt if already done) → mark executing → run
 *   - on failure: run compensations in reverse, skipping any already done
 * Resume-safe: if the engine crashed mid-step or mid-compensation, calling
 * runOperation again converges to a healthy state (forward done OR fully
 * compensated). The only escape hatch is `compensation_failed`, set when a
 * compensate step throws — the reconciler will retry with backoff.
 */
export async function runOperation(op: OperationRow, def: AnyOpKind): Promise<void> {
  return withOpContext(op.id, () => runOperationInner(op, def));
}

async function runOperationInner(op: OperationRow, def: AnyOpKind): Promise<void> {
  const input = JSON.parse(op.input_json || "{}");

  // A compensation can durably enqueue destroy children. If the engine died
  // after enqueue and a later reconcile adopted the parent's resources, those
  // old children must not wake up and delete the live resources.
  if (def.kind.startsWith("destroy_") && op.parent_id != null) {
    const inherited = findSupersedingAncestorOperation(op);
    if (inherited) {
      const detail =
        `destructive child fenced: parent operation #${inherited.ancestor.id} ` +
        `was superseded by operation #${inherited.supersededBy.id}`;
      log(`op#${op.id} ${detail}`);
      markOperationFinished(op.id, "cancelled", {
        message: detail,
        compensation_skipped: true,
        superseded_by: inherited.supersededBy.id,
      });
      return;
    }
  }

  // Resume directly into compensation if the op was interrupted there.
  if (op.status === "compensating") {
    bumpAttempt(op.id);
    log(`op#${op.id} resuming compensation (attempt ${op.attempt + 1})`);
    await runCompensation(op, def, input, /*cancelled=*/ false);
    return;
  }

  markOperationRunning(op.id);

  const ctx = buildContext(op, input, "forward");

  // Prior completed forward steps (from earlier attempts).
  const priorByName = new Map<string, unknown>();
  for (const row of getCompletedForwardSteps(op.id)) {
    priorByName.set(row.step, row.output_json ? JSON.parse(row.output_json) : null);
  }
  const priorOutputs: Record<string, unknown> = Object.fromEntries(priorByName);

  try {
    for (const step of def.steps) {
      if (ctx.isCancelRequested()) throw new CancelledError();

      if (priorByName.has(step.name)) {
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

      await runOneForwardStep(op, ctx, step, priorOutputs);
    }

    markOperationFinished(op.id, "done");
  } catch (err) {
    const cancelled = err instanceof CancelledError || ctx.isCancelRequested();
    log(`op#${op.id} forward failed`, errMsg(err), cancelled ? "(cancelled)" : "");
    markOperationCompensating(op.id, { message: errMsg(err), cancelled });
    await runCompensation(op, def, input, cancelled, { message: errMsg(err), cancelled });
  }
}

async function runOneForwardStep(
  op: OperationRow,
  ctx: OpContext,
  step: Step,
  priorOutputs: Record<string, unknown>,
): Promise<void> {
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
    // Probe first — if the side effect already exists (e.g. from a prior crashed
    // attempt of this same step), adopt its output and skip `run`.
    if (step.probe) {
      try {
        const adopted = await step.probe(ctx, priorOutputs);
        if (adopted != null) {
          finishStep({
            opId: op.id,
            seq,
            status: "ok",
            detail: "adopted existing side effect (probe)",
            outputJson: JSON.stringify(adopted ?? null),
          });
          priorOutputs[step.name] = adopted;
          return;
        }
      } catch (err) {
        // Probe failure is informational, not fatal — fall through to run.
        log(`op#${op.id} probe ${step.name} failed (continuing):`, errMsg(err));
      }
    }

    markStepExecuting(op.id, seq);
    const out = await step.run(ctx, priorOutputs);
    finishStep({
      opId: op.id,
      seq,
      status: "ok",
      outputJson: JSON.stringify(out ?? null),
    });
    priorOutputs[step.name] = out;
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

/**
 * Walk forward steps in reverse, running compensate for any that completed
 * (in this or a prior attempt). Skips compensate steps already recorded as
 * ok/skipped (durable resume). On compensate failure, marks the op
 * `compensation_failed` so the reconciler can retry.
 */
async function runCompensation(
  op: OperationRow,
  def: AnyOpKind,
  input: unknown,
  cancelled: boolean,
  error?: unknown,
): Promise<void> {
  const ctx = buildContext(op, input, "compensate");

  // Outputs from completed forward steps (needed by compensate fns).
  const priorOutputs: Record<string, unknown> = {};
  const forwardDone = new Set<string>();
  for (const row of getCompletedForwardSteps(op.id)) {
    forwardDone.add(row.step);
    priorOutputs[row.step] = row.output_json ? JSON.parse(row.output_json) : null;
  }

  // Compensate phase rows that already finished (across crashes/restarts).
  const compensateDone = new Set<string>();
  for (const row of getCompletedCompensateSteps(op.id)) {
    compensateDone.add(row.step);
  }

  // Ownership expires the moment a newer operation begins reconciling any of
  // the same logical resources. This is deliberately checked before *and*
  // during the reverse walk: an old rollback must prefer leaking/reviewing a
  // resource over deleting one that a later successful run now serves from.
  const skipSupersededCompensation = (supersededBy: OperationRow): void => {
    const detail =
      `compensation fenced: resources were adopted by newer operation #${supersededBy.id} ` +
      `(${supersededBy.kind}, ${supersededBy.status})`;
    for (let i = def.steps.length - 1; i >= 0; i--) {
      const step = def.steps[i];
      if (!step.compensate || !forwardDone.has(step.name) || compensateDone.has(step.name)) continue;
      const seq = nextStepSeq(op.id);
      insertStep({
        opId: op.id,
        seq,
        step: step.name,
        phase: "compensate",
        status: "skipped",
        detail,
      });
    }
    markOperationFinished(op.id, cancelled ? "cancelled" : "compensated", {
      ...(error && typeof error === "object" ? error as Record<string, unknown> : {}),
      message: detail,
      compensation_skipped: true,
      superseded_by: supersededBy.id,
    });
  };

  const initiallySuperseded = findSupersedingOperation(op);
  if (initiallySuperseded) {
    skipSupersededCompensation(initiallySuperseded);
    return;
  }

  let anyFailed = false;
  for (let i = def.steps.length - 1; i >= 0; i--) {
    const step = def.steps[i];
    if (!step.compensate) continue;
    if (!forwardDone.has(step.name)) continue;
    if (compensateDone.has(step.name)) continue;

    const superseded = findSupersedingOperation(op);
    if (superseded) {
      skipSupersededCompensation(superseded);
      return;
    }

    const seq = nextStepSeq(op.id);
    insertStep({
      opId: op.id,
      seq,
      step: step.name,
      phase: "compensate",
      status: "started",
    });

    const out = priorOutputs[step.name];

    // probeCompensated lets a step short-circuit if the resource is already gone
    // (e.g. compensate ran successfully but engine crashed before finishStep).
    if (step.probeCompensated) {
      try {
        const gone = await step.probeCompensated(ctx, out, priorOutputs);
        if (gone) {
          finishStep({
            opId: op.id,
            seq,
            status: "skipped",
            detail: "side effect already gone (probeCompensated)",
          });
          continue;
        }
      } catch (err) {
        log(`op#${op.id} probeCompensated ${step.name} failed (continuing):`, errMsg(err));
      }
    }

    markStepExecuting(op.id, seq);
    try {
      await step.compensate!(ctx, out, priorOutputs);
      finishStep({ opId: op.id, seq, status: "ok" });
      compensateDone.add(step.name);
    } catch (err) {
      finishStep({
        opId: op.id,
        seq,
        status: "failed",
        detail: errMsg(err),
      });
      log(`op#${op.id} compensate ${step.name} failed:`, errMsg(err));
      anyFailed = true;
      // Continue compensating earlier steps — best-effort rollback.
    }
  }

  if (anyFailed) {
    // Leave status as 'compensating' but flag the op finished for the
    // reconciler. Actually: mark as compensation_failed terminal — reconciler
    // will only retry while still in 'compensating'. We stay in compensating
    // so the reconciler keeps retrying; if attempts exceed budget the
    // reconciler escalates to compensation_failed.
    log(`op#${op.id} compensation incomplete — left in 'compensating' for retry`);
    // No finishStep on the operation; leave status='compensating'.
    return;
  }

  markOperationFinished(
    op.id,
    cancelled ? "cancelled" : "compensated",
    error,
  );
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
