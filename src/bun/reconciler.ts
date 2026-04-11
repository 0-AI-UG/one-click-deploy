import * as db from "./db.ts";
import type { AppRow, ReplicaRow, ServiceRow, ServiceInstanceRow } from "./db.ts";
import { sshExec, healthCheck, composeHealthCheck, restartCompose, restartContainer, serviceHealthCheck } from "./remote/index.ts";
import { evaluateAutoScale } from "./scale.ts";
import { getCatalogEntry } from "./services/catalog.ts";
import { reconcileNetwork } from "./scale/network-reconciler.ts";
import { syncAppCaddy } from "./scale/caddy-manager.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const TICK_MS = 30_000;
const METRICS_RETENTION_SEC = 24 * 60 * 60;
const UNHEALTHY_RESTART_THRESHOLD = 2;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function collectReplica(replica: ReplicaRow, app: AppRow): Promise<void> {
  // Stopped replicas are light-sleep anchors — their container is off by
  // design. Do NOT collect metrics, do NOT health-check them, and do NOT
  // auto-restart them. Any of those would resurrect the sleeping app.
  if (replica.status === "stopped") return;
  const server = db.getServer(replica.server_id);
  if (!server) return;
  const hostKey = server.ssh_host_key || undefined;

  // Metrics
  try {
    const result = await sshExec(
      server.ipv4,
      `su - deploy -c "docker stats --no-stream --format '{{json .}}' ${replica.container_name} 2>/dev/null"`,
      hostKey
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      const stats = JSON.parse(result.stdout.trim());
      const cpu = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
      const mem = parseFloat(stats.MemPerc?.replace("%", "") || "0");
      db.updateReplicaMetrics(replica.id, cpu, mem);
      db.insertMetricSample({
        replica_id: replica.id,
        app_id: replica.app_id,
        cpu_percent: cpu,
        memory_percent: mem,
      });
    }
  } catch (err) {
    log("metrics", `replica ${replica.container_name}: ${err}`);
  }

  // Health
  try {
    const check = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, replica.host_port, 1, hostKey)
      : await healthCheck(server.ipv4, replica.container_name, replica.host_port, 1, hostKey);

    if (check.healthy) {
      db.updateReplicaStatus(replica.id, "running");
      db.touchReplicaHealth(replica.id);
      db.resetUnhealthyTicks(replica.id);
    } else {
      db.updateReplicaStatus(replica.id, "unhealthy");
      const ticks = db.incrementUnhealthyTicks(replica.id);
      log("health", `replica ${replica.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        log("health", `auto-restarting ${replica.container_name}`);
        try {
          if (app.deploy_mode === "compose") {
            await restartCompose(server.ipv4, app.name, hostKey);
          } else {
            await restartContainer(server.ipv4, replica.container_name, hostKey);
          }
          db.resetUnhealthyTicks(replica.id);
          db.insertScalingEvent({
            app_id: replica.app_id,
            event_type: "auto_restart",
            from_count: 0,
            to_count: 0,
            reason: `replica ${replica.container_name} unhealthy for ${ticks} ticks`,
          });
        } catch (err) {
          log("health", `restart failed: ${err}`);
        }
      }
    }
  } catch (err) {
    log("health", `check failed for ${replica.container_name}: ${err}`);
  }
}

async function reconcileCaddyRoutes(byApp: Map<number, ReplicaRow[]>): Promise<void> {
  // The panel owns a single Caddy ingress now. Re-sync every tracked app on
  // every tick so the upstream pool reflects the current replica set: a
  // replica flipping running ↔ unhealthy gets re-added/removed, a gc'd
  // replica's dial entry disappears, and a restarted Caddy gets its routes
  // back. syncAppCaddy is idempotent and each call is ~4 curls, so the cost
  // is bounded by the app count.
  for (const [appId] of byApp) {
    const app = db.getApp(appId);
    if (!app || !app.domain) continue;
    if (app.status !== "running" && app.status !== "unhealthy") continue;
    try {
      await syncAppCaddy(app.id);
    } catch (err) {
      log("caddy", `Panel route sync failed for ${app.name}: ${err}`);
    }
  }
}

async function collectServiceInstance(instance: ServiceInstanceRow, service: ServiceRow): Promise<void> {
  const server = db.getServer(instance.server_id);
  if (!server) return;
  const hostKey = server.ssh_host_key || undefined;

  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) return;

  // Metrics (same as app replicas — docker stats works for any container)
  try {
    const result = await sshExec(
      server.ipv4,
      `su - deploy -c "docker stats --no-stream --format '{{json .}}' ${instance.container_name} 2>/dev/null"`,
      hostKey
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      const stats = JSON.parse(result.stdout.trim());
      const cpu = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
      const mem = parseFloat(stats.MemPerc?.replace("%", "") || "0");
      db.updateServiceInstanceMetrics(instance.id, cpu, mem);
    }
  } catch (err) {
    log("metrics", `service instance ${instance.container_name}: ${err}`);
  }

  // Health check via docker exec
  try {
    const healthCmd = instance.role === "replica" && catalog.replication.replicaHealthCmd
      ? catalog.replication.replicaHealthCmd
      : catalog.healthCmd;

    const check = await serviceHealthCheck(
      server.ipv4, instance.container_name, healthCmd, 1, hostKey
    );

    if (check.healthy) {
      db.updateServiceInstanceStatus(instance.id, "running");
      db.touchServiceInstanceHealth(instance.id);
      db.resetServiceInstanceUnhealthyTicks(instance.id);
    } else {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      const ticks = db.incrementServiceInstanceUnhealthyTicks(instance.id);
      log("health", `service instance ${instance.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        log("health", `auto-restarting service ${instance.container_name}`);
        try {
          await restartContainer(server.ipv4, instance.container_name, hostKey);
          db.resetServiceInstanceUnhealthyTicks(instance.id);
        } catch (err) {
          log("health", `restart failed: ${err}`);
        }
      }
    }
  } catch (err) {
    log("health", `check failed for service instance ${instance.container_name}: ${err}`);
  }
}

async function tick(): Promise<void> {
  if (running) {
    log("tick", "skip (previous tick still running)");
    return;
  }
  running = true;
  const start = Date.now();
  try {
    // --- App replicas ---
    const replicas = db.getAllReplicas();
    const byApp = new Map<number, ReplicaRow[]>();
    for (const r of replicas) {
      const list = byApp.get(r.app_id) ?? [];
      list.push(r);
      byApp.set(r.app_id, list);
    }

    for (const [appId, list] of byApp) {
      const app = db.getApp(appId);
      if (!app) continue;

      for (const replica of list) {
        await collectReplica(replica, app);
      }

      // Propagate replica health to app status
      // Only touch apps that are in a "live" state (running/unhealthy), not deploying/paused
      if (app.status === "running" || app.status === "unhealthy") {
        // Ignore stopped replicas (light-sleep anchors) when computing app
        // health — they are intentionally off.
        const freshReplicas = list
          .map((r) => db.getReplica(r.id))
          .filter((r): r is NonNullable<typeof r> => r !== null && r.status !== "stopped");
        const allHealthy = freshReplicas.length > 0 && freshReplicas.every((r) => r.status === "running");
        const newStatus = allHealthy ? "running" : "unhealthy";
        if (newStatus !== app.status) {
          log("status", `app ${appId}: ${app.status} -> ${newStatus}`);
          db.updateAppStatus(appId, newStatus);
        }
      }

      if (app.autoscale_enabled) {
        try {
          await evaluateAutoScale(appId);
        } catch (err) {
          log("autoscale", `app ${appId}: ${err}`);
        }
      }
    }

    // Drag every server onto the shared private network + keep
    // `<app>.ocd.internal` lines in /etc/hosts in sync. Runs every tick but
    // is a no-op once servers are attached and hosts files are current.
    try {
      await reconcileNetwork();
    } catch (err) {
      log("network", `reconcile failed: ${err}`);
    }

    // Ensure Caddy routes exist on the panel for all live apps (restores
    // routes lost by Caddy restarts).
    await reconcileCaddyRoutes(byApp);

    // --- Infrastructure services ---
    const services = db.getServices();
    let serviceCount = 0;
    for (const service of services) {
      if (service.status === "paused" || service.status === "deploying") continue;

      const instances = db.getServiceInstances(service.id);
      for (const instance of instances) {
        await collectServiceInstance(instance, service);
      }

      // Propagate instance health to service status
      if (service.status === "running" || service.status === "unhealthy") {
        const freshInstances = instances.map((i) => db.getServiceInstance(i.id)).filter((i): i is NonNullable<typeof i> => i !== null);
        const allHealthy = freshInstances.length > 0 && freshInstances.every((i) => i.status === "running");
        const newStatus = allHealthy ? "running" : "unhealthy";
        if (newStatus !== service.status) {
          log("status", `service ${service.id}: ${service.status} -> ${newStatus}`);
          db.updateServiceStatus(service.id, newStatus);
        }
      }
      serviceCount++;
    }

    db.pruneOldMetrics(METRICS_RETENTION_SEC);
    log("tick", `done in ${Date.now() - start}ms (${byApp.size} apps, ${serviceCount} services)`);
  } catch (err) {
    log("tick", `error: ${err}`);
  } finally {
    running = false;
  }
}

export function startReconciler(): void {
  if (timer) return;
  log("start", `reconciler starting (tick=${TICK_MS}ms)`);
  // Delay first tick so server finishes booting
  setTimeout(() => { void tick(); }, 5_000);
  timer = setInterval(() => { void tick(); }, TICK_MS);
}

export function stopReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
