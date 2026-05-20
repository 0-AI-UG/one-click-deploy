import {
  listPendingOperations,
  listRunningOperations,
  markOperationFinished,
  abandonInFlightSteps,
  getOperation,
} from "../shared/db/operations.ts";
import { tryAcquire, release } from "./scheduler.ts";
import { getOp } from "./ops/registry.ts";
import { runOperation } from "./step-runner.ts";
import type { OperationRow } from "../shared/db/operations.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine]`, ...args);
}

const MAX_CONCURRENT = parseInt(process.env.ENGINE_CONCURRENCY || "4", 10);
const POLL_INTERVAL_MS = 400;

const inFlight = new Map<number, Promise<void>>();
const parked = new Set<number>();

function activeCount(): number {
  let n = 0;
  for (const id of inFlight.keys()) if (!parked.has(id)) n++;
  return n;
}

export function parkOp(opId: number): void {
  if (inFlight.has(opId)) parked.add(opId);
}

export function unparkOp(opId: number): void {
  parked.delete(opId);
}

let stopping = false;

export async function startEngine(): Promise<void> {
  log(`starting (concurrency=${MAX_CONCURRENT})`);
  await resumeInterruptedOperations();
  loop();
}

export function stopEngine(): void {
  stopping = true;
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      log("tick error:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log("loop exiting; awaiting in-flight ops");
  await Promise.all(inFlight.values());
  log("stopped");
}

async function tick(): Promise<void> {
  if (activeCount() >= MAX_CONCURRENT) return;
  const pending = listPendingOperations(MAX_CONCURRENT * 2);
  for (const op of pending) {
    if (activeCount() >= MAX_CONCURRENT) break;
    if (inFlight.has(op.id)) continue;
    tryStart(op);
  }
  // Pick up ops parked in 'compensating' (e.g. resumed after restart or
  // re-enqueued by the reconciler).
  const compensating = listRunningOperations().filter((o) => o.status === "compensating");
  for (const op of compensating) {
    if (activeCount() >= MAX_CONCURRENT) break;
    if (inFlight.has(op.id)) continue;
    tryStart(op);
  }
}

/**
 * Requeue an op stuck in 'compensating' for another compensation pass. Used by
 * the reconciler's stuck-state sweep. Idempotent: a no-op if the op is already
 * in-flight or no longer compensating.
 */
export function requeueForCompensation(opId: number): void {
  if (inFlight.has(opId)) return;
  const op = getOperation(opId);
  if (!op || op.status !== "compensating") return;
  // Step-runner will re-enter runCompensation based on op.status.
  abandonInFlightSteps(opId);
  tryStart(op);
}

function tryStart(op: OperationRow): void {
  const def = getOp(op.kind);
  if (!def) {
    log(`op#${op.id} unknown kind '${op.kind}' — failing`);
    markOperationFinished(op.id, "failed", { message: `unknown op kind '${op.kind}'` });
    return;
  }
  const keys = safeParseKeys(op.resource_keys);
  const acq = tryAcquire(keys, op.id, op.kind);
  if (!acq.ok) return;

  // Defer invocation by a microtask so inFlight.set runs first. Without this,
  // a step that calls ctx.park() before its first await would hit parkOp while
  // inFlight is still empty, making the park a no-op.
  const promise = Promise.resolve()
    .then(() => runOperation(op, def))
    .catch((err) => log(`op#${op.id} runner threw:`, err))
    .finally(() => {
      release(keys);
      inFlight.delete(op.id);
      parked.delete(op.id);
    });
  inFlight.set(op.id, promise);
}

async function resumeInterruptedOperations(): Promise<void> {
  const interrupted = listRunningOperations();
  if (interrupted.length === 0) return;
  log(`resuming ${interrupted.length} interrupted op(s) after restart`);
  const { default: db } = await import("../shared/db/connection.ts");
  for (const op of interrupted) {
    // Mark any step row caught mid-flight ('started' or 'executing') as
    // failed-and-abandoned. The step-runner will re-attempt the step on resume;
    // its `probe` (if any) will adopt the existing side effect so the world
    // remains consistent.
    abandonInFlightSteps(op.id);

    if (op.status === "compensating") {
      // Leave it as 'compensating' — runOperation detects this and re-enters
      // runCompensation, which skips compensate steps already marked ok/skipped.
      log(`op#${op.id} will resume compensation`);
      continue;
    }
    // Running ops go back to pending so the main loop picks them up.
    db.run("UPDATE operations SET status = 'pending' WHERE id = ?", [op.id]);
  }
}

function safeParseKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
