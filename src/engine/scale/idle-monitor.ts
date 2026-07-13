import * as db from "../../shared/db.ts";
import { log } from "./types.ts";
import { requestMetricsFresh } from "./request-metrics.ts";

// HPA-style tolerance band: ignore load within ±10% of the target so the
// autoscaler doesn't flap desired_replicas around the threshold.
const TOLERANCE = 0.1;

type ScaleEvent = "autoscale_up" | "autoscale_down" | "autoscale_sleep";

// Write a new desired_replicas and record the intent. The reconciler's
// convergence loop performs the physical scale on a later tick — this function
// only decides. Returns true when desired actually changed.
function setDesired(appId: number, from: number, to: number, eventType: ScaleEvent): boolean {
  const app = db.getApp(appId);
  if (!app || app.desired_replicas === to) return false;
  db.updateAppScaling(appId, { desired_replicas: to, last_scale_at: new Date().toISOString() });
  db.insertScalingEvent({
    app_id: appId,
    event_type: eventType,
    from_count: from,
    to_count: to,
    reason: "autoscaler",
  });
  return true;
}

// In-memory tracker: when each app first entered sustained idle state.
// Cleared when metrics rise above idle thresholds or the app scales.
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

  // Check cooldown — no desired_replicas change while cooling down.
  if (app.last_scale_at) {
    const elapsed = (Date.now() - new Date(app.last_scale_at).getTime()) / 1000;
    if (elapsed < app.autoscale_cooldown) {
      log("autoscale", `Cooldown active for app ${appId} (${Math.round(app.autoscale_cooldown - elapsed)}s remaining)`);
      return;
    }
  }

  const count = replicas.length;
  // docker stats CPUPerc is "cores used × 100" (100% = one whole core), NOT a
  // fraction of the container's --cpus ceiling. Normalize each replica against
  // its own CPU limit so the threshold means "% of the app's allowed CPU" —
  // matching how memory_percent already behaves (docker MemPerc = used/--memory)
  // and how K8s HPA measures utilization against the pod's limit. Without this,
  // an app capped at 0.5 cores could never reach an 80% threshold, and one
  // given 2 cores would scale up at 40% of its real headroom. Prefer the
  // scraped per-replica ceiling; fall back to the app's configured limit, then
  // to 1 core (DEFAULT_CPUS) for a replica not yet scraped.
  const cpuLimitFallback = app.cpu_limit || 1;
  const avgCpu = replicas.reduce((sum, r) => {
    const limitCores = r.cpu_limit_cores > 0 ? r.cpu_limit_cores : cpuLimitFallback;
    return sum + r.cpu_percent / limitCores;
  }, 0) / count;
  const avgMem = replicas.reduce((sum, r) => sum + r.memory_percent, 0) / count;
  const serverIds = [...new Set(replicas.map((r) => r.server_id))];

  // HTTP-routed apps (same predicate as the ingress renderer) have Traefik
  // request counters; raw-TCP apps (internal_protocol='tcp', no auth) don't, so
  // request-rate scaling and the request-driven sleep path only apply to them.
  const httpRouted = app.internal_protocol === "http" || !!app.auth_password_hash;

  // Volume apps can never scale beyond 1 replica (cloud volumes attach 1:1).
  // Treat them as capped at 1 even if their stored max_replicas is higher.
  const effectiveMax = app.volume_id ? Math.min(1, app.max_replicas) : app.max_replicas;

  // Utilization ratios vs. the configured thresholds. >1 means over target.
  // CPU and memory are the universal saturation signals (every app has them).
  // Request rate is an additional HPA-style "Pods" metric: each metric proposes
  // a desired replica count and the highest (max) wins. It only participates
  // for HTTP apps with a configured target and fresh Traefik metrics —
  // otherwise it drops out and CPU/RAM alone drive the decision (a stale scrape
  // must never zero the signal, or it would look like idle traffic).
  const cpuRatio = avgCpu / app.autoscale_cpu_threshold;
  const memRatio = avgMem / app.autoscale_mem_threshold;
  const reqScalingOn = httpRouted && app.autoscale_req_threshold > 0 && requestMetricsFresh(serverIds);
  // requests_per_min is the app-wide total; compare the per-replica average to
  // the target so ceil(count * ratio) converges to the right replica count.
  const reqRatio = reqScalingOn
    ? (app.requests_per_min / count) / app.autoscale_req_threshold
    : 0;
  const ratio = Math.max(cpuRatio, memRatio, reqRatio);

  log("autoscale", `App ${appId}: avgCPU=${avgCpu.toFixed(1)}% avgMem=${avgMem.toFixed(1)}%${reqScalingOn ? ` rpm=${app.requests_per_min.toFixed(0)} reqRatio=${reqRatio.toFixed(2)}` : ""} ratio=${ratio.toFixed(2)} replicas=${count} min=${app.min_replicas} max=${effectiveMax}${app.volume_id ? " (volume-capped)" : ""}`);

  // --- Scale up (proportional, HPA formula) ---
  if (ratio > 1 + TOLERANCE && count < effectiveMax) {
    const target = Math.min(effectiveMax, Math.max(count + 1, Math.ceil(count * ratio)));
    idleSince.delete(appId);
    if (setDesired(appId, count, target, "autoscale_up")) {
      log("autoscale", `App ${appId}: desired ${count} -> ${target} (ratio ${ratio.toFixed(2)})`);
    }
    return;
  }

  // Within the tolerance band — hold steady and clear any idle tracking.
  const isIdle = ratio < 1 - TOLERANCE;
  if (!isIdle) {
    idleSince.delete(appId);
    return;
  }

  const canScaleToZero = count === 1 && app.min_replicas === 0;

  // --- Scale-to-zero, request-driven ---
  // Sleep once the app has had zero requests (public + internal — an app called
  // by another app never sleeps) for its scale_to_zero_after window.
  if (canScaleToZero && httpRouted) {
    idleSince.delete(appId); // CPU idle tracker is only for the legacy path
    const idleTimeout = app.scale_to_zero_after ?? 300;
    // Fail safe: a failed scrape is "unknown", not "zero traffic" — no sleep
    // decision until this tick's metrics arrived from every replica's server.
    if (!requestMetricsFresh(serverIds)) {
      log("autoscale", `App ${appId}: request metrics stale/missing — skipping sleep decision`);
      return;
    }
    if (!app.last_request_at) {
      // Never observed a request — start the idle window now instead of
      // sleeping blind.
      db.touchAppLastRequest(appId);
      log("autoscale", `App ${appId}: no request history, sleep after ${idleTimeout}s without requests`);
      return;
    }
    const idleFor = (Date.now() - new Date(app.last_request_at).getTime()) / 1000;
    if (idleFor < idleTimeout) {
      log("autoscale", `App ${appId}: last request ${Math.round(idleFor)}s ago / ${idleTimeout}s before sleep`);
      return;
    }
    if (setDesired(appId, count, 0, "autoscale_sleep")) {
      log("autoscale", `App ${appId}: desired -> 0 (no requests for ${Math.round(idleFor)}s)`);
    }
    return;
  }

  // --- Scale down (proportional) ---
  if (count > app.min_replicas) {
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
      idleSince.delete(appId);
      if (setDesired(appId, count, 0, "autoscale_sleep")) {
        log("autoscale", `App ${appId}: desired -> 0 (idle for ${Math.round(idleDuration)}s)`);
      }
    } else {
      // Proportional scale-down, floored at min_replicas (and never to 0 here —
      // that's the scale-to-zero path above).
      const target = Math.max(app.min_replicas, 1, Math.ceil(count * ratio));
      if (target < count) {
        idleSince.delete(appId);
        if (setDesired(appId, count, target, "autoscale_down")) {
          log("autoscale", `App ${appId}: desired ${count} -> ${target} (ratio ${ratio.toFixed(2)})`);
        }
      }
    }
  }
}
