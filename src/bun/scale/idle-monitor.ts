import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { log } from "./types.ts";
import { scaleApp } from "./scale-app.ts";

// In-memory tracker: when each app first entered sustained idle state.
// Cleared when metrics rise above idle thresholds or app scales.
export const idleSince = new Map<number, number>();

export async function collectMetrics(appId: number): Promise<void> {
  const replicas = db.getReplicas(appId);

  for (const replica of replicas) {
    const server = db.getServer(replica.server_id);
    if (!server) continue;

    try {
      const hostKey = server.ssh_host_key || undefined;
      const result = await hetzner.sshExec(
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

  const replicas = db.getReplicas(appId);
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

  log("autoscale", `App ${appId}: avgCPU=${avgCpu.toFixed(1)}% avgMem=${avgMem.toFixed(1)}% replicas=${replicas.length} min=${app.min_replicas} max=${app.max_replicas}`);

  // Scale up
  if (
    (avgCpu > app.autoscale_cpu_threshold || avgMem > app.autoscale_mem_threshold) &&
    replicas.length < app.max_replicas
  ) {
    log("autoscale", `Scaling up app ${appId}: CPU=${avgCpu.toFixed(1)}% > ${app.autoscale_cpu_threshold}% or MEM=${avgMem.toFixed(1)}% > ${app.autoscale_mem_threshold}%`);
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
      idleSince.delete(appId);
      log("autoscale", `Scaling to zero app ${appId}: idle for ${Math.round(idleDuration)}s (threshold: ${idleTimeout}s)`);
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
    } else {
      // Normal scale-down (N → N-1, where N-1 >= 1)
      log("autoscale", `Scaling down app ${appId}: CPU=${avgCpu.toFixed(1)}% < ${app.autoscale_cpu_threshold * 0.5}% and MEM=${avgMem.toFixed(1)}% < ${app.autoscale_mem_threshold * 0.5}%`);
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
    }
  }
}
