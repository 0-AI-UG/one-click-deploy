import * as db from "../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow } from "../shared/db.ts";
import { ensureHostLogPolicy, pruneServer } from "../shared/remote/index.ts";
import { evaluateAutoScale, convergeAppReplicas } from "./scale/index.ts";
import { reconcileNetwork } from "./scale/network-reconciler.ts";
import { reconcileProxy } from "./scale/proxy-manager.ts";
import { reconcileTraefik } from "./scale/traefik-manager.ts";
import { ingestServerRequestMetrics } from "./scale/request-metrics.ts";
import { collectServerMetrics } from "./metrics-parse.ts";
import { checkReplicaHealth, HEALTH_EXEMPT_STATUSES } from "./health.ts";
import { sweepStuckStates } from "./stuck-sweep.ts";
import { sweepExpiredProvisionalVolumes } from "./provisional-volume-sweep.ts";
import { reconcileAllAppDns } from "./dns-reconciler.ts";
import { reconcilePanelDns } from "./dns-reconciler.ts";
import { startController, stopControllers } from "./controller-runtime.ts";
import {
  reconcileActiveVolumes,
  reconcileFirewall,
  reconcileServerGc,
  reconcileServersAndNetwork,
} from "./infrastructure-reconciler.ts";
import { reconcileAppRuntime } from "./app-runtime-reconciler.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const TICK_MS = 30_000;
const METRICS_RETENTION_SEC = 24 * 60 * 60;
const AVAILABILITY_RETENTION_SEC = 7 * 24 * 60 * 60;

let running = false;

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

interface ServerWorkItem {
  server: ServerRow;
  replicas: { replica: ReplicaRow; app: AppRow }[];
}

async function processServer(work: ServerWorkItem): Promise<void> {
  const { server } = work;

  // --- Phase 1: One SSH call for all docker stats + server metrics ---
  // Traefik runs on the panel only, so only the panel is scraped for request
  // counters; workers skip the curl entirely.
  const isPanel = server.id === db.getPanel()?.server_id;
  const { containerStats, serverMetrics, traefikMetrics } = await collectServerMetrics(server, {
    scrapeTraefik: isPanel,
  });

  // Request activity from the panel's Traefik per-service counters. On a failed
  // scrape (null) the panel is left stale so sleep decisions skip. Workers never
  // produce these metrics, so we only ingest for the panel.
  if (isPanel) ingestServerRequestMetrics(server.id, traefikMetrics);

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
      item = { server, replicas: [] };
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

    // Also ensure servers with no containers still get server-level metrics
    const allServers = db.getServers();
    for (const server of allServers) {
      if (server.ipv4) ensureServer(server.id);
    }
    // Replica convergence is level-triggered, so apps with zero materialized
    // rows must still participate (for example after confirmed server loss).
    for (const app of db.getApps()) {
      if (!byApp.has(app.id)) byApp.set(app.id, []);
    }

    // --- Process all servers in parallel ---
    const workItems = Array.from(serverWork.values());
    const serverResults = await Promise.allSettled(workItems.map((work) => processServer(work)));
    for (const [index, result] of serverResults.entries()) {
      if (result.status === "rejected") {
        const server = workItems[index]?.server;
        log("server", `${server?.name ?? index}: ${result.reason}`);
      }
    }

    // --- Status propagation ---
    for (const [appId, list] of byApp) {
      const app = db.getApp(appId);
      if (!app) continue;

      if (app.status === "running" || app.status === "unhealthy") {
        const freshReplicas = list
          .map((r) => db.getReplica(r.id))
          .filter((r): r is NonNullable<typeof r> =>
            r !== null &&
            db.getServer(r.server_id)?.status === "ready" &&
            !HEALTH_EXEMPT_STATUSES.has(r.status)
          );
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

    // --- Cleanup ---
    db.pruneOldMetrics(METRICS_RETENTION_SEC);
    db.pruneOldServerMetrics(METRICS_RETENTION_SEC);
    db.pruneOldAvailabilitySamples(AVAILABILITY_RETENTION_SEC);

    log("tick", `done in ${Date.now() - start}ms (${byApp.size} apps, ${serverWork.size} servers)`);
  } catch (err) {
    log("tick", `error: ${err}`);
  } finally {
    running = false;
  }
}

export function startReconciler(): void {
  log("start", "starting isolated desired-state controllers");
  startController({ name: "workloads", intervalMs: TICK_MS, timeoutMs: 25_000, run: tick });
  startController({
    name: "dns",
    intervalMs: 30_000,
    timeoutMs: 25_000,
    run: async () => {
      const results = await Promise.allSettled([reconcileAllAppDns(), reconcilePanelDns()]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) throw new Error(`DNS branches failed: ${failures.map((result) => result.reason).join("; ")}`);
    },
  });
  startController({ name: "proxy", intervalMs: 30_000, timeoutMs: 25_000, run: reconcileProxy });
  startController({
    name: "network",
    intervalMs: 30_000,
    timeoutMs: 25_000,
    run: async () => { await reconcileServersAndNetwork(); await reconcileNetwork(); },
  });
  startController({ name: "ingress", intervalMs: 30_000, timeoutMs: 25_000, run: reconcileTraefik });
  startController({ name: "app-runtime", intervalMs: 60_000, timeoutMs: 50_000, run: reconcileAppRuntime });
  startController({ name: "server-gc", intervalMs: 30_000, timeoutMs: 25_000, run: reconcileServerGc });
  startController({ name: "volumes", intervalMs: 120_000, timeoutMs: 90_000, run: reconcileActiveVolumes });
  startController({ name: "firewall", intervalMs: 300_000, timeoutMs: 60_000, run: reconcileFirewall });
  startController({ name: "stuck-operations", intervalMs: 30_000, run: sweepStuckStates });
  startController({ name: "maintenance", intervalMs: 300_000, timeoutMs: 240_000, run: maintenanceTick });
}

export function stopReconciler(): void {
  stopControllers();
}

async function maintenanceTick(): Promise<void> {
  let sweepError: unknown = null;
  try {
    await sweepExpiredProvisionalVolumes();
  } catch (error) {
    sweepError = error;
  }
  const results = await Promise.allSettled(db.getServers().filter((server) => server.ipv4 && server.status === "ready").map(async (server) => {
    const hostKey = server.ssh_host_key || undefined;
    const activeAppNames = db.getApps(server.id).map((app) => app.name);
    const protectedContainerNames = [
      ...db.getReplicasByServer(server.id).map((replica) => replica.container_name),
    ];
    const panel = db.getPanel();
    const panelContainerName = panel?.server_id === server.id ? panel.name : undefined;
    if (panelContainerName) {
      activeAppNames.push(panelContainerName);
      protectedContainerNames.push(panelContainerName);
    }
    await ensureHostLogPolicy(server.ipv4, hostKey);
    await pruneServer(server.ipv4, hostKey, {
      activeAppNames,
      protectedContainerNames,
      panelContainerName,
    });
  }));
  const failures = results.filter((result) => result.status === "rejected");
  if (sweepError || failures.length > 0) {
    throw new Error([
      sweepError ? `volume sweep: ${sweepError}` : "",
      failures.length > 0
        ? `${failures.length} server(s): ${failures.map((result) => result.reason).join("; ")}`
        : "",
    ].filter(Boolean).join("; "));
  }
}
