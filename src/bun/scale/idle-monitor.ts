import * as db from "../db.ts";
import { sshExec } from "../remote/index.ts";
import { log } from "./types.ts";
import { scaleApp } from "./scale-app.ts";
import { tryAcquireLock } from "../op-lock.ts";

// In-memory tracker: when each app first entered sustained idle state.
// Cleared when metrics rise above idle thresholds or app scales.
export const idleSince = new Map<number, number>();

export async function collectMetrics(appId: number): Promise<void> {
  const replicas = db.getReplicas(appId);

  for (const replica of replicas) {
    // Skip light-sleep anchors — they have no running container to stat.
    if (replica.status === "stopped") continue;
    const server = db.getServer(replica.server_id);
    if (!server) continue;

    try {
      const hostKey = server.ssh_host_key || undefined;
      const result = await sshExec(
        server.ipv4,
        `su - deploy -c "docker stats --no-stream --format '{{json .}}' ${replica.container_name} 2>/dev/null"`,
        hostKey
      );

      if (result.exitCode === 0 && result.stdout.trim()) {
        const stats = JSON.parse(result.stdout.trim());
        const cpuPercent = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
        const memPercent = parseFloat(stats.MemPerc?.replace("%", "") || "0");
        db.updateReplicaMetrics(replica.id, cpuPercent, memPercent);
      }
    } catch (err) {
      log("metrics", `Failed to collect metrics for ${replica.container_name}: ${err}`);
    }
  }
}

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
    const lock = tryAcquireLock(`app:${appId}`, "autoscale");
    if ("busy" in lock) {
      log("autoscale", `Skipping app ${appId}: ${lock.holder} in progress`);
      return;
    }
    log("autoscale", `Scaling up app ${appId}: CPU=${avgCpu.toFixed(1)}% > ${app.autoscale_cpu_threshold}% or MEM=${avgMem.toFixed(1)}% > ${app.autoscale_mem_threshold}%`);
    try {
      const result = await scaleApp(appId, replicas.length + 1);
      if (result.ok) {
        db.insertScalingEvent({
          app_id: appId,
          event_type: "autoscale_up",
          from_count: replicas.length,
          to_count: replicas.length + 1,
          reason: `CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}% exceeded thresholds`,
        });
      }
    } finally {
      lock.release();
    }
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
    // Scale-to-zero requires sustained idle for scale_to_zero_after seconds
    if (replicas.length === 1 && app.min_replicas === 0) {
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
      // Sustained idle confirmed — scale to zero
      const lock = tryAcquireLock(`app:${appId}`, "autoscale");
      if ("busy" in lock) {
        log("autoscale", `Skipping app ${appId}: ${lock.holder} in progress`);
        return;
      }
      idleSince.delete(appId);
      log("autoscale", `Scaling to zero app ${appId}: idle for ${Math.round(idleDuration)}s (threshold: ${idleTimeout}s)`);
      try {
        const result = await scaleApp(appId, 0);
        if (result.ok) {
          db.insertScalingEvent({
            app_id: appId,
            event_type: "autoscale_sleep",
            from_count: 1,
            to_count: 0,
            reason: `Idle for ${Math.round(idleDuration)}s — CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}%`,
          });
        }
      } finally {
        lock.release();
      }
    } else {
      // Normal scale-down (N → N-1, where N-1 >= 1)
      const lock = tryAcquireLock(`app:${appId}`, "autoscale");
      if ("busy" in lock) {
        log("autoscale", `Skipping app ${appId}: ${lock.holder} in progress`);
        return;
      }
      log("autoscale", `Scaling down app ${appId}: CPU=${avgCpu.toFixed(1)}% < ${app.autoscale_cpu_threshold * 0.5}% and MEM=${avgMem.toFixed(1)}% < ${app.autoscale_mem_threshold * 0.5}%`);
      try {
        const result = await scaleApp(appId, replicas.length - 1);
        if (result.ok) {
          db.insertScalingEvent({
            app_id: appId,
            event_type: "autoscale_down",
            from_count: replicas.length,
            to_count: replicas.length - 1,
            reason: `CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}% below thresholds`,
          });
        }
      } finally {
        lock.release();
      }
    }
  }
}
