import * as db from "./db.ts";
import * as hetzner from "./hetzner/index.ts";
import { evaluateAutoScale } from "./scale.ts";
import { getCatalogEntry } from "./services/catalog.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const TICK_MS = 30_000;
const METRICS_RETENTION_SEC = 24 * 60 * 60;
const UNHEALTHY_RESTART_THRESHOLD = 2;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function collectReplica(replica: any, app: any): Promise<void> {
  const server = db.getServer(replica.server_id);
  if (!server) return;
  const hostKey = server.ssh_host_key || undefined;

  // Metrics
  try {
    const result = await hetzner.sshExec(
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
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, replica.host_port, 1, hostKey)
      : await hetzner.healthCheck(server.ipv4, replica.container_name, replica.host_port, 1, hostKey);

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
            await hetzner.restartCompose(server.ipv4, app.name, hostKey);
          } else {
            await hetzner.restartContainer(server.ipv4, replica.container_name, hostKey);
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

async function reconcileLB(app: any): Promise<void> {
  if (!app.hetzner_lb_id) return;

  // 1. LB still exists?
  try {
    await hetzner.getLoadBalancer(app.hetzner_lb_id);
  } catch (err) {
    log("lb", `app ${app.id} LB ${app.hetzner_lb_id} missing — clearing`);
    db.updateAppScaling(app.id, { hetzner_lb_id: "" });
    db.insertScalingEvent({
      app_id: app.id,
      event_type: "lb_missing",
      from_count: 0,
      to_count: 0,
      reason: `Hetzner LB ${app.hetzner_lb_id} not found`,
    });
    return;
  }

  // 2. Target diff
  try {
    const lb = await hetzner.getLoadBalancer(app.hetzner_lb_id);
    const lbTargetServerIds = new Set(
      (lb.targets || [])
        .filter((t: any) => t.type === "server" && t.server?.id)
        .map((t: any) => String(t.server.id))
    );
    const replicas = db.getReplicas(app.id);
    const wantServerIds = new Set<string>();
    for (const r of replicas) {
      const s = db.getServer(r.server_id);
      if (s) wantServerIds.add(String(s.hetzner_id));
    }

    for (const want of wantServerIds) {
      if (!lbTargetServerIds.has(want)) {
        log("lb", `app ${app.id}: adding missing target server=${want}`);
        try { await hetzner.addLBTarget(app.hetzner_lb_id, want); } catch (e) { log("lb", `add target failed: ${e}`); }
        db.insertScalingEvent({
          app_id: app.id,
          event_type: "lb_reconcile_add",
          from_count: 0,
          to_count: 0,
          reason: `added server ${want} to LB`,
        });
      }
    }
    for (const have of lbTargetServerIds) {
      if (!wantServerIds.has(have as string)) {
        log("lb", `app ${app.id}: removing orphan target server=${have}`);
        try { await hetzner.removeLBTarget(app.hetzner_lb_id, have as string); } catch (e) { log("lb", `remove target failed: ${e}`); }
        db.insertScalingEvent({
          app_id: app.id,
          event_type: "lb_reconcile_remove",
          from_count: 0,
          to_count: 0,
          reason: `removed orphan server ${have} from LB`,
        });
      }
    }
  } catch (err) {
    log("lb", `reconcile failed for app ${app.id}: ${err}`);
  }
}

async function reconcileCaddyRoutes(byApp: Map<number, any[]>): Promise<void> {
  // Group apps by server to batch checks
  const serverApps = new Map<number, { app: any; replica: any }[]>();
  for (const [appId, list] of byApp) {
    const app = db.getApp(appId);
    if (!app || !app.domain) continue;
    // Only reconcile single-replica apps not behind a LB (LB handles TLS)
    if (app.hetzner_lb_id) continue;
    if (app.status !== "running" && app.status !== "unhealthy") continue;
    const firstReplica = list[0];
    if (!firstReplica) continue;
    const items = serverApps.get(firstReplica.server_id) ?? [];
    items.push({ app, replica: firstReplica });
    serverApps.set(firstReplica.server_id, items);
  }

  for (const [serverId, items] of serverApps) {
    const server = db.getServer(serverId);
    if (!server) continue;
    const hostKey = server.ssh_host_key || undefined;

    for (const { app, replica } of items) {
      try {
        const exists = await hetzner.checkCaddyRoute(server.ipv4, app.domain, hostKey);
        if (!exists) {
          log("caddy", `Route missing for ${app.domain} — re-adding`);
          let caddyPort = replica.host_port;
          if (app.auth_password) {
            caddyPort = hetzner.authProxyPort(replica.host_port);
          }
          const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
          await hetzner.deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls, hostKey);
        }
      } catch (err) {
        log("caddy", `Route check failed for ${app.domain}: ${err}`);
      }
    }
  }
}

async function collectServiceInstance(instance: any, service: any): Promise<void> {
  const server = db.getServer(instance.server_id);
  if (!server) return;
  const hostKey = server.ssh_host_key || undefined;

  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) return;

  // Metrics (same as app replicas — docker stats works for any container)
  try {
    const result = await hetzner.sshExec(
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

    const check = await hetzner.serviceHealthCheck(
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
          await hetzner.restartContainer(server.ipv4, instance.container_name, hostKey);
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
    const byApp = new Map<number, any[]>();
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
        const freshReplicas = list.map((r) => db.getReplica(r.id)).filter(Boolean);
        const allHealthy = freshReplicas.length > 0 && freshReplicas.every((r: any) => r.status === "running");
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

      if (app.hetzner_lb_id) {
        await reconcileLB(app);
      }
    }

    // Ensure Caddy routes exist for all live apps (restores routes lost by Caddy restarts)
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
        const freshInstances = instances.map((i: any) => db.getServiceInstance(i.id)).filter(Boolean);
        const allHealthy = freshInstances.length > 0 && freshInstances.every((i: any) => i.status === "running");
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
