import { startEngine, stopEngine } from "./engine.ts";
import "./ops/index.ts"; // register op kinds
import { startReconciler, stopReconciler } from "./reconciler.ts";
import {
  registerEngine,
  updateEngineHeartbeat,
  removeEngine,
  isLeaderEngine,
  removeStaleEngines,
  releaseEngineResourceLocks,
} from "../shared/db/orgs.ts";
import { resetStaleOperations } from "../shared/db/operations.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:entry]`, ...args);
}

const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_ENGINE_INTERVAL_MS = 60_000;

const engineId = crypto.randomUUID();

let started = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let staleEngineTimer: ReturnType<typeof setInterval> | null = null;
let reconcilerRunning = false;

/**
 * Start the operation engine in-process (heartbeat + step runner + reconciler).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startEngineInProcess(): void {
  if (started) return;
  started = true;
  registerEngine(engineId);
  updateEngineHeartbeat(engineId);
  heartbeatTimer = setInterval(() => updateEngineHeartbeat(engineId), HEARTBEAT_INTERVAL_MS);
  log(`engine starting in-process (engineId=${engineId})`);
  startEngine(engineId).catch((err) => {
    log("startEngine failed:", err);
  });
  if (isLeaderEngine(engineId)) {
    startReconciler();
    reconcilerRunning = true;
  }
  staleEngineTimer = setInterval(() => {
    const stale = removeStaleEngines(30);
    for (const id of stale) {
      resetStaleOperations(id);
      releaseEngineResourceLocks(id);
    }
    // Start reconciler if we've become the leader and it's not already running.
    if (isLeaderEngine(engineId) && !reconcilerRunning) {
      startReconciler();
      reconcilerRunning = true;
    }
  }, STALE_ENGINE_INTERVAL_MS);
}

export function stopEngineInProcess(): void {
  if (!started) return;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (staleEngineTimer) clearInterval(staleEngineTimer);
  heartbeatTimer = null;
  staleEngineTimer = null;
  removeEngine(engineId);
  stopReconciler();
  stopEngine();
  started = false;
  reconcilerRunning = false;
}

// Standalone mode: when run directly via `bun run src/engine/entrypoint.ts`.
if (import.meta.main) {
  process.on("SIGTERM", () => {
    log("SIGTERM");
    stopEngineInProcess();
  });
  process.on("SIGINT", () => {
    log("SIGINT");
    stopEngineInProcess();
  });
  startEngineInProcess();
}
