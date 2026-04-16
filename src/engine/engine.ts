import {
  listPendingOperations,
  listRunningOperations,
  markOperationFinished,
  claimOperation,
} from "../shared/db/operations.ts";
import { tryAcquireResourceLock, releaseResourceLocks } from "../shared/db/orgs.ts";
import { getOp } from "./ops/registry.ts";
import { runOperation } from "./step-runner.ts";
import type { OperationRow } from "../shared/db/operations.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine]`, ...args);
}

const MAX_CONCURRENT = parseInt(process.env.ENGINE_CONCURRENCY || "4", 10);
const POLL_INTERVAL_MS = 400;

let engineId = "";

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

export async function startEngine(id: string): Promise<void> {
  engineId = id;
  log(`starting (concurrency=${MAX_CONCURRENT}, engineId=${engineId})`);
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
}

function tryStart(op: OperationRow): void {
  const def = getOp(op.kind);
  if (!def) {
    log(`op#${op.id} unknown kind '${op.kind}' — failing`);
    markOperationFinished(op.id, "failed", { message: `unknown op kind '${op.kind}'` });
    return;
  }
  const keys = safeParseKeys(op.resource_keys);
  // Acquire all resource locks in the DB; bail if any key is already held.
  for (const key of keys) {
    if (!tryAcquireResourceLock(key, engineId, op.id)) {
      // Release any locks we already acquired for this op before giving up.
      releaseResourceLocks(op.id);
      return;
    }
  }
  // Atomically claim the operation row so no other engine picks it up.
  if (!claimOperation(op.id, engineId)) {
    releaseResourceLocks(op.id);
    return;
  }

  // Defer invocation by a microtask so inFlight.set runs first. Without this,
  // a step that calls ctx.park() before its first await would hit parkOp while
  // inFlight is still empty, making the park a no-op.
  const promise = Promise.resolve()
    .then(() => runOperation(op, def))
    .catch((err) => log(`op#${op.id} runner threw:`, err))
    .finally(() => {
      releaseResourceLocks(op.id);
      inFlight.delete(op.id);
      parked.delete(op.id);
    });
  inFlight.set(op.id, promise);
}

async function resumeInterruptedOperations(): Promise<void> {
  const interrupted = listRunningOperations();
  if (interrupted.length === 0) return;
  log(`resuming ${interrupted.length} interrupted op(s) after restart`);
  // Mark them back to pending so the tick loop picks them up normally.
  for (const op of interrupted) {
    const { default: db } = await import("../shared/db/connection.ts");
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
