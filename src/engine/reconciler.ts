import * as db from "../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow, ServiceRow, ServiceInstanceRow } from "../shared/db.ts";
import { pruneServer } from "../shared/remote/index.ts";
import { evaluateAutoScale, convergeAppReplicas } from "./scale/index.ts";
import { reconcileNetwork } from "./scale/network-reconciler.ts";
import { reconcileProxy } from "./scale/proxy-manager.ts";
import { reconcileTraefik } from "./scale/traefik-manager.ts";
import { ingestServerRequestMetrics } from "./scale/request-metrics.ts";
import { collectServerMetrics } from "./metrics-parse.ts";
import { checkReplicaHealth, checkServiceInstanceHealth, HEALTH_EXEMPT_STATUSES } from "./health.ts";
import { sweepStuckStates } from "./stuck-sweep.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const TICK_MS = 30_000;
const METRICS_RETENTION_SEC = 24 * 60 * 60;
const AVAILABILITY_RETENTION_SEC = 7 * 24 * 60 * 60;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
const PRUNE_EVERY_N_TICKS = 10; // ~5 minutes at 30s/tick

// Whether the fleet firewall's rule set has been converged this process.
// ensureFirewall otherwise only runs during provisioning, so an existing
// fleet would never pick up newly added base rules (e.g. the public TCP/UDP
// port blocks). One-shot per engine process — a failure retries next tick.
let firewallConverged = false;

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

interface ServerWorkItem {
  server: ServerRow;
  replicas: { replica: ReplicaRow; app: AppRow }[];
  serviceInstances: { instance: ServiceInstanceRow; service: ServiceRow }[];
}

async function processServer(work: ServerWorkItem): Promise<void> {
  const { server } = work;

  // --- Phase 1: One SSH call for all docker stats + server metrics ---
  const { containerStats, serverMetrics, traefikMetrics } = await collectServerMetrics(server);

  // Request activity from Traefik's per-service counters. On a failed scrape
  // (null) the server is left stale so sleep decisions skip its apps.
  ingestServerRequestMetrics(server.id, traefikMetrics);

  // Apply container metrics to replicas
  for (const { replica } of work.replicas) {
    const stats = containerStats.get(replica.container_name);
    if (stats) {
      db.updateReplicaMetrics(replica.id, stats.cpu, stats.mem, {
        cpuLimitCores: stats.cpuLimitCores,
        memoryUsedMb: stats.memUsedMb,
        memoryLimitMb: stats.memLimitMb,
      });
      db.insertMetricSample({
        replica_id: replica.id,
        app_id: replica.app_id,
        cpu_percent: stats.cpu,
        memory_percent: stats.mem,
      });
    }
  }

  // Apply container metrics to service instances
  for (const { instance } of work.serviceInstances) {
    const stats = containerStats.get(instance.container_name);
    if (stats) {
      db.updateServiceInstanceMetrics(instance.id, stats.cpu, stats.mem, {
        cpuLimitCores: stats.cpuLimitCores,
        memoryUsedMb: stats.memUsedMb,
        memoryLimitMb: stats.memLimitMb,
      });
    }
  }

  // Apply server-level metrics
  if (serverMetrics) {
    db.insertServerMetricSample(
      server.id,
      serverMetrics.cpu,
      serverMetrics.mem,
      serverMetrics.diskUsedGb,
      serverMetrics.diskTotalGb,
    );
  }

  // --- Phase 2: Health checks for all containers on this server ---
  // Each check opens 1-2 fresh SSH connections (no multiplexing), and every
  // server's containers are probed every tick. Firing them all at once let a
  // busy server exceed sshd's MaxStartups (default 10 concurrent handshakes),
  // which drops connections and produced false "unhealthy" flaps. Cap the
  // per-server concurrency below that ceiling; checks are short so this costs
  // little wall-clock.
  const checks: Array<() => Promise<void>> = [];

  for (const { replica, app } of work.replicas) {
    if (replica.status === "stopped" || replica.status === "paused" || replica.status === "sleeping" || replica.status === "waking") continue;
    checks.push(() => checkReplicaHealth(replica, app, server));
  }

  for (const { instance, service } of work.serviceInstances) {
    if (instance.status === "paused" || instance.status === "stopped") continue;
    checks.push(() => checkServiceInstanceHealth(instance, service, server));
  }

  await runWithConcurrency(checks, HEALTH_CHECK_CONCURRENCY);
}

// Kept comfortably under sshd's default MaxStartups (10:30:100) so a tick's
// probe burst never trips connection throttling on a single host.
const HEALTH_CHECK_CONCURRENCY = 5;

// Run thunks with a bounded number in flight at once. Each rejection is
// swallowed per-task (the health checks already catch their own errors); this
// only governs scheduling.
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

async function tick(): Promise<void> {
  if (running) {
    log("tick", "skip (previous tick still running)");
    return;
  }
  running = true;
  const start = Date.now();
  try {
    // --- Gather all work, grouped by server ---
    const replicas = db.getAllReplicas();
    const byApp = new Map<number, ReplicaRow[]>();
    const serverWork = new Map<number, ServerWorkItem>();

    const ensureServer = (serverId: number): ServerWorkItem | null => {
      let item = serverWork.get(serverId);
      if (item) return item;
      const server = db.getServer(serverId);
      if (!server) return null;
      item = { server, replicas: [], serviceInstances: [] };
      serverWork.set(serverId, item);
      return item;
    };

    for (const replica of replicas) {
      // Build byApp index (needed for status propagation)
      const list = byApp.get(replica.app_id) ?? [];
      list.push(replica);
      byApp.set(replica.app_id, list);

      // Skip non-live replicas for metrics/health (but still include in byApp)
      if (replica.status === "stopped" || replica.status === "paused" || replica.status === "sleeping" || replica.status === "waking") continue;

      const app = db.getApp(replica.app_id);
      if (!app) continue;
      const work = ensureServer(replica.server_id);
      if (work) work.replicas.push({ replica, app });
    }

    const services = db.getServices();
    let serviceCount = 0;
    for (const service of services) {
      if (service.status === "paused" || service.status === "deploying") continue;
      const instances = db.getServiceInstances(service.id);
      for (const instance of instances) {
        if (instance.status === "paused" || instance.status === "stopped") continue;
        const work = ensureServer(instance.server_id);
        if (work) work.serviceInstances.push({ instance, service });
      }
      serviceCount++;
    }

    // Also ensure servers with no containers still get server-level metrics
    const allServers = db.getServers();
    for (const server of allServers) {
      if (server.ipv4) ensureServer(server.id);
    }

    // --- Process all servers in parallel ---
    await Promise.all(
      Array.from(serverWork.values()).map((work) => processServer(work)),
    );

    // --- Status propagation (app + service level) ---
    for (const [appId, list] of byApp) {
      const app = db.getApp(appId);
      if (!app) continue;

      if (app.status === "running" || app.status === "unhealthy") {
        const freshReplicas = list
          .map((r) => db.getReplica(r.id))
          .filter((r): r is NonNullable<typeof r> => r !== null && !HEALTH_EXEMPT_STATUSES.has(r.status));
        const allHealthy = freshReplicas.length > 0 && freshReplicas.every((r) => r.status === "running");
        const newStatus = allHealthy ? "running" : "unhealthy";
        if (newStatus !== app.status) {
          log("status", `app ${appId}: ${app.status} -> ${newStatus}`);
          db.updateAppStatus(appId, newStatus);
        }
      }

      // Autoscaler runs first (it only writes desired_replicas), then the
      // convergence loop makes the live replica count match desired — for both
      // autoscaled and manually-scaled apps. Level-triggered: manual scaling
      // and the deploy op set desired_replicas and this brings it about.
      if (app.autoscale_enabled) {
        try {
          await evaluateAutoScale(appId);
        } catch (err) {
          log("autoscale", `app ${appId}: ${err}`);
        }
      }
      try {
        await convergeAppReplicas(appId);
      } catch (err) {
        log("converge", `app ${appId}: ${err}`);
      }
    }

    // --- Availability SLO sampling (one sample per live app per tick) ---
    // Record whether each app currently meets its replica-count / host-spread /
    // location-spread target, feeding uptime% + MTTR. Apps that are
    // intentionally down (scaled to zero, or sleeping/paused/stopped/waking)
    // are skipped so scale-to-zero never registers as an outage. Fully guarded
    // so a sampling error can never break the reconcile tick.
    try {
      const serverLocation = new Map(allServers.map((s) => [s.id, s.location]));
      for (const app of db.getApps()) {
        if (app.desired_replicas === 0) continue;
        if (
          app.status === "sleeping" ||
          app.status === "paused" ||
          app.status === "stopped" ||
          app.status === "waking"
        ) {
          continue;
        }
        const running = db.getReplicas(app.id).filter((r) => r.status === "running");
        const running_count = running.length;
        const distinct_hosts = new Set(running.map((r) => r.server_id)).size;
        const distinct_locations = new Set(
          running.map((r) => serverLocation.get(r.server_id)).filter(Boolean),
        ).size;
        const meets_target = db.computeMeetsTarget({
          running_count,
          distinct_hosts,
          distinct_locations,
          min_replicas: app.min_replicas,
          min_locations: app.min_locations,
          max_per_host: app.max_per_host,
        });
        db.insertAvailabilitySample({
          app_id: app.id,
          meets_target,
          desired_count: app.desired_replicas,
          running_count,
          distinct_hosts,
          distinct_locations,
        });
      }
    } catch (err) {
      log("availability", `sampling failed: ${err}`);
    }

    for (const service of services) {
      if (service.status === "paused" || service.status === "deploying") continue;
      if (service.status === "running" || service.status === "unhealthy") {
        const instances = db.getServiceInstances(service.id);
        const freshInstances = instances
          .map((i) => db.getServiceInstance(i.id))
          .filter((i): i is NonNullable<typeof i> => i !== null && !HEALTH_EXEMPT_STATUSES.has(i.status));
        const allHealthy = freshInstances.length > 0 && freshInstances.every((i) => i.status === "running");
        const newStatus = allHealthy ? "running" : "unhealthy";
        if (newStatus !== service.status) {
          log("status", `service ${service.id}: ${service.status} -> ${newStatus}`);
          db.updateServiceStatus(service.id, newStatus);
        }
      }
    }

    // --- VIP proxy convergence: install/upgrade ocd-proxy on every ready
    // server and ship the rendered config. Runs before reconcileNetwork so
    // /etc/hosts flips an app to its VIP at earliest one tick after that
    // server's proxy is confirmed live ---
    try {
      await reconcileProxy();
    } catch (err) {
      log("proxy", `reconcile failed: ${err}`);
    }

    // --- Network reconciliation ---
    try {
      await reconcileNetwork();
    } catch (err) {
      log("network", `reconcile failed: ${err}`);
    }

    // --- Ingress drift repair: install Traefik on any ready server missing
    // it, then desired-state sync every server's dynamic config ---
    try {
      await reconcileTraefik();
    } catch (err) {
      log("ingress", `reconcile failed: ${err}`);
    }

    // --- One-shot firewall rule convergence (only meaningful when the fleet
    // has provider-managed servers; ensureFirewall is idempotent) ---
    if (!firewallConverged && db.getServers().some((s) => s.provider_id)) {
      try {
        const { hetzner } = await import("../shared/providers/index.ts");
        await hetzner.ensureFirewall();
        firewallConverged = true;
      } catch (err) {
        log("firewall", `converge failed: ${err}`);
      }
    }

    // --- Stuck-state sweep (surfaces cleanup_failed + stuck ops to op-logger) ---
    sweepStuckStates();

    // --- Cleanup ---
    db.pruneOldMetrics(METRICS_RETENTION_SEC);
    db.pruneOldServerMetrics(METRICS_RETENTION_SEC);
    db.pruneOldAvailabilitySamples(AVAILABILITY_RETENTION_SEC);

    // --- Periodic Docker prune (stopped containers, old images, build cache) ---
    tickCount++;
    if (tickCount % PRUNE_EVERY_N_TICKS === 0) {
      for (const work of serverWork.values()) {
        pruneServer(work.server.ipv4, work.server.ssh_host_key || undefined).catch((err) => {
          log("prune", `server ${work.server.ipv4}: ${err}`);
        });
      }
    }

    log("tick", `done in ${Date.now() - start}ms (${byApp.size} apps, ${serviceCount} services, ${serverWork.size} servers)`);
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
