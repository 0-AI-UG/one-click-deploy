import * as db from "../../shared/db.ts";
import { log } from "./types.ts";
import { enqueue } from "../../server/ipc/enqueue.ts";
import { requestMetricsFresh } from "./request-metrics.ts";

function enqueueAutoscale(appId: number, decision: "up" | "down" | "sleep", targetReplicas: number) {
  const bucket = Math.floor(Date.now() / 60000);
  const kind = decision === "up" ? "scale_up" : decision === "sleep" ? "sleep" : "scale_down";
  enqueue({
    kind,
    resourceKeys: [`app:${appId}`],
    input: decision === "sleep" ? { appId } : { appId, targetReplicas },
    trigger: "autoscaler",
    triggeredBy: "idle-monitor",
    idempotencyKey: `idle-monitor:${appId}:${decision}:${bucket}`,
  });
}

// In-memory tracker: when each app first entered sustained idle state.
// Cleared when metrics rise above idle thresholds or app scales.
export const idleSince = new Map<number, number>();

export async function evaluateAutoScale(appId: number): Promise<void> {
  const app = db.getApp(appId);
  if (!app || !app.autoscale_enabled) return;

  // Sleeping / waking apps are off-limits to the autoscaler — their replicas
  // are either stopped anchors or in the middle of being brought back up.
  if (app.status === "sleeping" || app.status === "waking") {
    idleSince.delete(appId);
    return;
  }

  // Only consider running (or unhealthy-but-not-stopped) replicas for metrics.
  // A status='stopped' replica row is a light-sleep anchor: treating it as
  // "present but idle" would cause the autoscaler to try to sleep an already-
  // sleeping app on every tick.
  const replicas = db.getReplicas(appId).filter((r) => r.status !== "stopped");
  if (replicas.length === 0) return;

  // Check cooldown
  if (app.last_scale_at) {
    const elapsed = (Date.now() - new Date(app.last_scale_at).getTime()) / 1000;
    if (elapsed < app.autoscale_cooldown) {
      log("autoscale", `Cooldown active for app ${appId} (${Math.round(app.autoscale_cooldown - elapsed)}s remaining)`);
      return;
    }
  }

  const avgCpu = replicas.reduce((sum, r) => sum + r.cpu_percent, 0) / replicas.length;
  const avgMem = replicas.reduce((sum, r) => sum + r.memory_percent, 0) / replicas.length;

  // Volume apps can never scale beyond 1 replica (cloud volumes attach 1:1).
  // Treat them as capped at 1 even if their stored max_replicas is higher
  // (e.g. a volume attached after the fact without the cap being re-applied).
  const effectiveMax = app.volume_id ? Math.min(1, app.max_replicas) : app.max_replicas;

  log("autoscale", `App ${appId}: avgCPU=${avgCpu.toFixed(1)}% avgMem=${avgMem.toFixed(1)}% replicas=${replicas.length} min=${app.min_replicas} max=${effectiveMax}${app.volume_id ? " (volume-capped)" : ""}`);

  // Scale up
  if (
    (avgCpu > app.autoscale_cpu_threshold || avgMem > app.autoscale_mem_threshold) &&
    replicas.length < effectiveMax
  ) {
    log("autoscale", `Enqueue scale_up app ${appId}: CPU=${avgCpu.toFixed(1)}% > ${app.autoscale_cpu_threshold}% or MEM=${avgMem.toFixed(1)}% > ${app.autoscale_mem_threshold}%`);
    enqueueAutoscale(appId, "up", replicas.length + 1);
    return;
  }

  const canScaleToZero = replicas.length === 1 && app.min_replicas === 0;
  // HTTP-routed apps (same predicate as the ingress renderer) have Traefik
  // request counters; raw-TCP apps (health_check=0, no auth) don't, so they
  // keep the legacy CPU sustained-idle heuristic below.
  const httpRouted = !!app.health_check || !!app.auth_password_hash;

  // Scale-to-zero, request-driven: sleep once the app has had zero requests
  // (public + internal — an app called by another app never sleeps) for its
  // scale_to_zero_after window.
  if (canScaleToZero && httpRouted) {
    idleSince.delete(appId); // CPU idle tracker is only for the legacy path
    const idleTimeout = app.scale_to_zero_after ?? 300;
    const serverIds = [...new Set(replicas.map((r) => r.server_id))];
    // Fail safe: a failed scrape is "unknown", not "zero traffic" — no sleep
    // decision until this tick's metrics arrived from every replica's server.
    if (!requestMetricsFresh(serverIds)) {
      log("autoscale", `App ${appId}: request metrics stale/missing — skipping sleep decision`);
      return;
    }
    if (!app.last_request_at) {
      // Never observed a request (row predates tracking, or genuinely no
      // traffic yet) — start the idle window now instead of sleeping blind.
      db.touchAppLastRequest(appId);
      log("autoscale", `App ${appId}: no request history, sleep after ${idleTimeout}s without requests`);
      return;
    }
    const idleFor = (Date.now() - new Date(app.last_request_at).getTime()) / 1000;
    if (idleFor < idleTimeout) {
      log("autoscale", `App ${appId}: last request ${Math.round(idleFor)}s ago / ${idleTimeout}s before sleep`);
      return;
    }
    log("autoscale", `Enqueue sleep app ${appId}: no requests for ${Math.round(idleFor)}s (threshold: ${idleTimeout}s)`);
    enqueueAutoscale(appId, "sleep", 0);
    return;
  }

  // Scale down
  const isIdle = avgCpu < app.autoscale_cpu_threshold * 0.5 &&
    avgMem < app.autoscale_mem_threshold * 0.5;

  if (!isIdle) {
    // Metrics are not idle — clear any tracked idle start
    idleSince.delete(appId);
    return;
  }

  if (replicas.length > app.min_replicas) {
    // Legacy CPU-based scale-to-zero for TCP-routed apps: requires sustained
    // idle for scale_to_zero_after seconds.
    if (canScaleToZero) {
      const idleTimeout = app.scale_to_zero_after ?? 300;
      const now = Date.now();
      if (!idleSince.has(appId)) {
        idleSince.set(appId, now);
        log("autoscale", `App ${appId}: idle detected, will sleep after ${idleTimeout}s of sustained idle`);
        return;
      }
      const idleDuration = (now - idleSince.get(appId)!) / 1000;
      if (idleDuration < idleTimeout) {
        log("autoscale", `App ${appId}: idle for ${Math.round(idleDuration)}s / ${idleTimeout}s before sleep`);
        return;
      }
      // Sustained idle confirmed — enqueue sleep
      idleSince.delete(appId);
      log("autoscale", `Enqueue sleep app ${appId}: idle for ${Math.round(idleDuration)}s (threshold: ${idleTimeout}s)`);
      enqueueAutoscale(appId, "sleep", 0);
    } else {
      // Normal scale-down (N → N-1, where N-1 >= 1)
      log("autoscale", `Enqueue scale_down app ${appId}: CPU=${avgCpu.toFixed(1)}% < ${app.autoscale_cpu_threshold * 0.5}% and MEM=${avgMem.toFixed(1)}% < ${app.autoscale_mem_threshold * 0.5}%`);
      enqueueAutoscale(appId, "down", replicas.length - 1);
    }
  }
}
