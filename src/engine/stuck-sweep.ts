// Stuck-state sweep: surfaces cleanup_failed resources to the op-logger and
// unwedges operations left mid-flight by a crash. Runs once per reconciler tick
// but lives next to engine.ts because it drives the operation lifecycle
// (markOperationFinished, requeueForCompensation, reviving zombie 'running' ops).

import * as db from "../shared/db.ts";
import dbConn from "../shared/db/connection.ts";
import type { OperationRow } from "../shared/db/operations.ts";
import { getOperation, markOperationFinished } from "../shared/db/operations.ts";
import { requeueForCompensation } from "./engine.ts";
import { currentHolder } from "./scheduler.ts";
import { reconcileStaleStackStates } from "./resource-state.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const STUCK_COMPENSATING_MIN = 5;
const STUCK_PENDING_RUNNING_MIN = 10;
const MAX_COMPENSATION_ATTEMPTS = 5;

export function sweepStuckStates(): void {
  try {
    const apps = db.getApps().filter((a) => a.status === "cleanup_failed");
    for (const a of apps) {
      log("sweep", `app#${a.id} (${a.name}) is cleanup_failed — manual recovery may be needed`);
    }
  } catch (err) {
    log("sweep", `apps query failed: ${err}`);
  }
  try {
    const services = db.getServices().filter((s) => s.status === "cleanup_failed");
    for (const s of services) {
      log("sweep", `service#${s.id} (${s.name}) is cleanup_failed — manual recovery may be needed`);
    }
  } catch (err) {
    log("sweep", `services query failed: ${err}`);
  }
  try {
    const servers = db.getServers().filter((s) => s.status === "cleanup_failed");
    for (const s of servers) {
      log("sweep", `server#${s.id} (${s.name}) is cleanup_failed — manual recovery may be needed`);
    }
  } catch (err) {
    log("sweep", `servers query failed: ${err}`);
  }
  try {
    const stuckComp = dbConn
      .query(
        `SELECT id, kind, started_at, last_step, attempt FROM operations
          WHERE status = 'compensating'
            AND started_at IS NOT NULL
            AND started_at < datetime('now', ?)`,
      )
      .all(`-${STUCK_COMPENSATING_MIN} minutes`) as Array<Pick<OperationRow, "id" | "kind" | "started_at" | "last_step" | "attempt">>;
    for (const op of stuckComp) {
      if (op.attempt >= MAX_COMPENSATION_ATTEMPTS) {
        log("sweep", `op#${op.id} (${op.kind}) exhausted compensation retries (attempt=${op.attempt}) — marking compensation_failed`);
        markOperationFinished(op.id, "compensation_failed", {
          message: "compensation retries exhausted; affected resources may be stranded",
        });
        continue;
      }
      log("sweep", `op#${op.id} (${op.kind}) stuck in 'compensating' since ${op.started_at} (last_step=${op.last_step}, attempt=${op.attempt}) — re-enqueueing`);
      try {
        requeueForCompensation(op.id);
      } catch (err) {
        log("sweep", `requeue failed for op#${op.id}: ${err}`);
      }
    }
  } catch (err) {
    log("sweep", `stuck compensating query failed: ${err}`);
  }
  try {
    const stuck = dbConn
      .query(
        `SELECT id, kind, status, started_at, enqueued_at, last_step FROM operations
          WHERE status IN ('pending','running')
            AND COALESCE(started_at, enqueued_at) < datetime('now', ?)`,
      )
      .all(`-${STUCK_PENDING_RUNNING_MIN} minutes`) as Array<{
        id: number; kind: string; status: string; started_at: string | null; enqueued_at: string; last_step: string | null;
      }>;
    for (const op of stuck) {
      log("sweep", `op#${op.id} (${op.kind}) stuck in '${op.status}' since ${op.started_at ?? op.enqueued_at} (last_step=${op.last_step})`);
      // A 'running' op with no in-process holder is a zombie from a prior
      // crash. Revert it to 'pending' so the main loop picks it up. The
      // step-runner's probe/skip logic guarantees no double-execution of
      // already-completed steps.
      if (op.status === "running") {
        try {
          const full = getOperation(op.id);
          const keys = full ? JSON.parse(full.resource_keys) as unknown : [];
          const held = Array.isArray(keys) && keys.some((key) => currentHolder(String(key))?.opId === op.id);
          if (held) {
            log("sweep", `op#${op.id} is still held by the live engine — leaving it running`);
            continue;
          }
          dbConn.run("UPDATE operations SET status = 'pending' WHERE id = ? AND status = 'running'", [op.id]);
        } catch (err) {
          log("sweep", `revive failed for op#${op.id}: ${err}`);
        }
      }
    }
  } catch (err) {
    log("sweep", `stuck pending/running query failed: ${err}`);
  }
  // Detect crash between stop_containers and mark_sleeping: all replicas
  // stopped but the app status didn't get flipped. Correct it.
  try {
    const apps = db.getApps();
    for (const app of apps) {
      if (app.status === "sleeping" || app.status === "deploying" || app.status === "stopped") continue;
      const replicas = db.getReplicas(app.id);
      if (replicas.length === 0) continue;
      const allStopped = replicas.every((r) => r.status === "stopped" || r.status === "sleeping");
      if (allStopped) {
        log("sweep", `app#${app.id} (${app.name}): all replicas stopped but status='${app.status}' — flipping to sleeping`);
        try { db.updateAppStatus(app.id, "sleeping"); } catch (err) { log("sweep", `flip failed: ${err}`); }
      }
    }
  } catch (err) {
    log("sweep", `sleep-state correction failed: ${err}`);
  }
  try {
    reconcileStaleStackStates();
  } catch (err) {
    log("sweep", `stack-state reconciliation failed: ${err}`);
  }
}
