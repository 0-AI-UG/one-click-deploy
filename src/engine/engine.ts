import {
  listPendingOperations,
  listRunningOperations,
  markOperationFinished,
} from "../bun/db/operations.ts";
import { tryAcquire, release } from "./scheduler.ts";
import { getOp } from "./ops/registry.ts";
import { runOperation } from "./step-runner.ts";
import type { OperationRow } from "../bun/db/operations.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine]`, ...args);
}

const MAX_CONCURRENT = parseInt(process.env.ENGINE_CONCURRENCY || "4", 10);
const POLL_INTERVAL_MS = 400;

const inFlight = new Map<number, Promise<void>>();

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
  if (inFlight.size >= MAX_CONCURRENT) return;
  const pending = listPendingOperations(MAX_CONCURRENT * 2);
  for (const op of pending) {
    if (inFlight.size >= MAX_CONCURRENT) break;
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
  const acq = tryAcquire(keys, op.id, op.kind);
  if (!acq.ok) return;

  const promise = runOperation(op, def)
    .catch((err) => log(`op#${op.id} runner threw:`, err))
    .finally(() => {
      release(keys);
      inFlight.delete(op.id);
    });
  inFlight.set(op.id, promise);
}

async function resumeInterruptedOperations(): Promise<void> {
  const interrupted = listRunningOperations();
  if (interrupted.length === 0) return;
  log(`resuming ${interrupted.length} interrupted op(s) after restart`);
  // Mark them back to pending so the tick loop picks them up normally.
  for (const op of interrupted) {
    const { default: db } = await import("../bun/db/connection.ts");
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
