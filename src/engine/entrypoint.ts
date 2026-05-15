import { startEngine, stopEngine } from "./engine.ts";
import "./ops/index.ts"; // register op kinds
import { startReconciler, stopReconciler } from "./reconciler.ts";
import { patchConsoleForOpLogs } from "./op-logger.ts";
import db from "../shared/db/connection.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:entry]`, ...args);
}

const HEARTBEAT_INTERVAL_MS = 5000;

function heartbeat(): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES ('engine_heartbeat', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [new Date().toISOString()],
  );
}

let started = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the operation engine in-process (heartbeat + step runner + reconciler).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startEngineInProcess(): void {
  if (started) return;
  started = true;
  patchConsoleForOpLogs();
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  log("engine starting in-process");
  startEngine().catch((err) => {
    log("startEngine failed:", err);
  });
  startReconciler();
}

export function stopEngineInProcess(): void {
  if (!started) return;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  stopReconciler();
  stopEngine();
  started = false;
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
