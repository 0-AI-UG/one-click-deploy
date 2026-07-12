import * as db from "../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow, ServiceRow, ServiceInstanceRow } from "../shared/db.ts";
import { sshExec, probeAppHealth, composeHealthCheck, restartCompose, restartContainer, serviceHealthCheck, pruneServer, startAppReplica } from "../shared/remote/index.ts";
import { resolveAppEnvVars } from "../shared/env-crypto.ts";
import { evaluateAutoScale } from "./scale-api.ts";
import { getCatalogEntry } from "../shared/services/catalog.ts";
import { reconcileNetwork } from "./scale/network-reconciler.ts";
import { reconcileTraefik } from "./scale/traefik-manager.ts";
import { TRAEFIK_METRICS_PORT } from "./scale/traefik-config.ts";
import { ingestServerRequestMetrics } from "./scale/request-metrics.ts";
import { replicaBindHost } from "./scale/types.ts";
import dbConn from "../shared/db/connection.ts";
import type { OperationRow } from "../shared/db/operations.ts";
import { markOperationFinished } from "../shared/db/operations.ts";
import { requeueForCompensation } from "./engine.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const TICK_MS = 30_000;
const METRICS_RETENTION_SEC = 24 * 60 * 60;
const UNHEALTHY_RESTART_THRESHOLD = 2;
/** Compose-kind services live here (apps use /home/deploy/apps). */
const SERVICE_COMPOSE_DIR = "/home/deploy/services";

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
// Per-server batched metrics collection
// ---------------------------------------------------------------------------

/** Parse docker stats JSON lines into a map of container_name -> {cpu, mem} */
function parseDockerStats(stdout: string): Map<string, { cpu: number; mem: number }> {
  const result = new Map<string, { cpu: number; mem: number }>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const stats = JSON.parse(trimmed);
      const name = stats.Name as string;
      if (!name) continue;
      const cpu = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
      const mem = parseFloat(stats.MemPerc?.replace("%", "") || "0");
      result.set(name, { cpu, mem });
    } catch {
      // skip malformed lines
    }
  }
  return result;
}

/** Parse server-level CPU, memory, and root-fs disk from top + /proc/meminfo + df output */
function parseServerMetrics(stdout: string): { cpu: number; mem: number; diskUsedGb: number; diskTotalGb: number } | null {
  const lines = stdout.split("\n");
  const cpuLine = lines.find((l) => l.includes("Cpu"));
  let cpuPercent: number | null = null;
  if (cpuLine) {
    const idleMatch = cpuLine.match(/([\d.]+)\s*id/);
    if (idleMatch) cpuPercent = Math.round((100 - parseFloat(idleMatch[1])) * 10) / 10;
  }
  let memTotal = 0, memAvailable = 0;
  for (const line of lines) {
    const totalMatch = line.match(/MemTotal:\s+(\d+)/);
    const availMatch = line.match(/MemAvailable:\s+(\d+)/);
    if (totalMatch) memTotal = parseInt(totalMatch[1]);
    if (availMatch) memAvailable = parseInt(availMatch[1]);
  }
  const memPercent = memTotal > 0 ? Math.round((1 - memAvailable / memTotal) * 1000) / 10 : null;

  // df line format: "DISK <used_kib> <total_kib>"
  let diskUsedGb = 0, diskTotalGb = 0;
  const dfLine = lines.find((l) => l.startsWith("DISK "));
  if (dfLine) {
    const parts = dfLine.trim().split(/\s+/);
    const usedK = parseInt(parts[1] || "0", 10);
    const totalK = parseInt(parts[2] || "0", 10);
    if (usedK > 0) diskUsedGb = Math.round((usedK / 1024 / 1024) * 10) / 10;
    if (totalK > 0) diskTotalGb = Math.round((totalK / 1024 / 1024) * 10) / 10;
  }

  if (cpuPercent != null && memPercent != null) return { cpu: cpuPercent, mem: memPercent, diskUsedGb, diskTotalGb };
  return null;
}

/**
 * Single SSH call per server: collect docker stats for all containers, server
 * CPU/RAM, and Traefik's Prometheus request counters in one shot.
 */
async function collectServerMetrics(
  server: ServerRow,
): Promise<{
  containerStats: Map<string, { cpu: number; mem: number }>;
  serverMetrics: { cpu: number; mem: number; diskUsedGb: number; diskTotalGb: number } | null;
  /** Raw Prometheus text from the local Traefik; null when the scrape failed. */
  traefikMetrics: string | null;
}> {
  const hostKey = server.ssh_host_key || undefined;
  const cmd = [
    `su - deploy -c "docker stats --no-stream --format '{{json .}}' 2>/dev/null"`,
    `echo '---SEPARATOR---'`,
    `top -bn1 | grep '%Cpu' | head -1`,
    `grep -E '^(MemTotal|MemAvailable):' /proc/meminfo`,
    `df -Pk / | awk 'NR==2 {print "DISK", $3, $2}'`,
    `echo '---TRAEFIK-METRICS---'`,
    // Subshell so a down/mid-upgrade Traefik doesn't fail the whole batch; an
    // empty metrics section is a failed scrape (never treated as zero traffic).
    `(curl -sf --max-time 5 http://127.0.0.1:${TRAEFIK_METRICS_PORT}/metrics || true)`,
  ].join(" && ");

  try {
    const result = await sshExec(server.ipv4, cmd, hostKey);
    if (result.exitCode !== 0) return { containerStats: new Map(), serverMetrics: null, traefikMetrics: null };

    const [dockerPart, rest] = result.stdout.split("---SEPARATOR---");
    const [metricsPart, traefikPart] = (rest || "").split("---TRAEFIK-METRICS---");
    const containerStats = parseDockerStats(dockerPart || "");
    const serverMetrics = parseServerMetrics(metricsPart || "");
    return { containerStats, serverMetrics, traefikMetrics: traefikPart?.trim() ? traefikPart : null };
  } catch (err) {
    log("metrics", `server ${server.ipv4}: ${err}`);
    return { containerStats: new Map(), serverMetrics: null, traefikMetrics: null };
  }
}

// ---------------------------------------------------------------------------
// Health checks (run in parallel per server)
// ---------------------------------------------------------------------------

/**
 * Last-resort recovery when `docker restart` can't bring a replica back — the
 * container was removed out-of-band, or it's wedged in a state containerd
 * can't kill ("tried to kill container, but did not receive an exit event").
 * Force-remove it and re-run from the existing `:latest` image. Requires the
 * image to still be present; a genuinely missing image needs a full redeploy
 * from source, so we surface that as an error rather than silently failing.
 */
async function recreateReplica(
  server: ServerRow,
  app: AppRow,
  replica: ReplicaRow,
  hostKey: string | undefined,
): Promise<void> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const image = `${app.name}:latest`;
  const present = await sshExec(server.ipv4, asUser(`docker image inspect ${image} >/dev/null 2>&1 && echo yes || echo no`), hostKey);
  if (present.stdout.trim() !== "yes") {
    throw new Error(`image ${image} not present — redeploy required`);
  }
  const envVars = await resolveAppEnvVars(app);
  const envFilePath = Object.keys(envVars).length > 0 ? `/home/deploy/apps/${app.name}/.env.deploy` : undefined;
  // rm -f (startAppReplica's default) clears both the missing-container and
  // wedged-container cases before re-running. If the wedged container also
  // resists removal, the run fails on the name/port conflict and we surface
  // it (dockerd-level intervention).
  await startAppReplica(server.ipv4, {
    containerName: replica.container_name,
    image,
    appName: app.name,
    network: null,
    bindAddr: replicaBindHost(server),
    hostPort: replica.host_port,
    containerPort: app.container_port,
    envFilePath,
    volumeMount: app.volume_mount || undefined,
    extraVolumes: db.parseExtraVolumes(app.extra_volumes),
    memoryMb: app.memory_mb || undefined,
  }, hostKey);
  log("health", `recreated ${replica.container_name} from ${image}`);
}

/**
 * Statuses that mean a container is intentionally not serving traffic. A
 * pause/stop/sleep op can land while a health check is already in flight
 * (ticks snapshot replicas before ops mutate them), so check results must be
 * re-validated against the live row before any status write or restart —
 * otherwise the reconciler clobbers the paused status and auto-restarts a
 * deliberately paused container.
 */
const HEALTH_EXEMPT_STATUSES = new Set(["paused", "stopped", "sleeping", "waking"]);

export async function checkReplicaHealth(
  replica: ReplicaRow,
  app: AppRow,
  server: ServerRow,
): Promise<void> {
  if (!server.private_ipv4) return;
  const hostKey = server.ssh_host_key || undefined;
  const bindHost = replicaBindHost(server);
  try {
    const check = await probeAppHealth(app, server.ipv4, replica.container_name, bindHost, replica.host_port, 1, hostKey);

    const current = db.getReplica(replica.id);
    if (!current || HEALTH_EXEMPT_STATUSES.has(current.status)) return;

    if (check.healthy) {
      db.updateReplicaStatus(replica.id, "running");
      db.touchReplicaHealth(replica.id);
      db.resetUnhealthyTicks(replica.id);
    } else {
      db.updateReplicaStatus(replica.id, "unhealthy");
      const ticks = db.incrementUnhealthyTicks(replica.id);
      log("health", `replica ${replica.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        const currentApp = db.getApp(app.id);
        if (!currentApp || (currentApp.status !== "running" && currentApp.status !== "unhealthy")) {
          log("health", `skipping auto-restart of ${replica.container_name}: app status is ${currentApp?.status ?? "gone"}`);
          return;
        }
        log("health", `auto-restarting ${replica.container_name}`);
        try {
          await restartContainer(server.ipv4, replica.container_name, hostKey);
          db.resetUnhealthyTicks(replica.id);
          db.insertScalingEvent({
            app_id: replica.app_id,
            event_type: "auto_restart",
            from_count: 0,
            to_count: 0,
            reason: `replica ${replica.container_name} unhealthy for ${ticks} ticks`,
          });
        } catch (err) {
          // `docker restart` can't recover a container that no longer exists or
          // is wedged (containerd lost its exit event). Fall back to recreate.
          log("health", `restart failed: ${err} — attempting recreate`);
          try {
            await recreateReplica(server, app, replica, hostKey);
            db.resetUnhealthyTicks(replica.id);
            db.insertScalingEvent({
              app_id: replica.app_id,
              event_type: "auto_recreate",
              from_count: 0,
              to_count: 0,
              reason: `restart failed for ${replica.container_name}; recreated from image`,
            });
          } catch (recreateErr) {
            log("health", `recreate failed for ${replica.container_name}: ${recreateErr}`);
          }
        }
      }
    }
  } catch (err) {
    log("health", `check failed for ${replica.container_name}: ${err}`);
  }
}

async function checkServiceInstanceHealth(
  instance: ServiceInstanceRow,
  service: ServiceRow,
  server: ServerRow,
): Promise<void> {
  const hostKey = server.ssh_host_key || undefined;
  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) return;
  const isCompose = service.deploy_kind === "compose";

  try {
    const check = isCompose
      ? await composeHealthCheck(
          server.ipv4, instance.container_name, replicaBindHost(server), instance.host_port, 1, hostKey, SERVICE_COMPOSE_DIR,
        )
      : await serviceHealthCheck(
          server.ipv4, instance.container_name, catalog.healthCmd, 1, hostKey,
        );

    const current = db.getServiceInstance(instance.id);
    if (!current || HEALTH_EXEMPT_STATUSES.has(current.status)) return;

    if (check.healthy) {
      db.updateServiceInstanceStatus(instance.id, "running");
      db.touchServiceInstanceHealth(instance.id);
      db.resetServiceInstanceUnhealthyTicks(instance.id);
    } else {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      const ticks = db.incrementServiceInstanceUnhealthyTicks(instance.id);
      log("health", `service instance ${instance.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        const currentService = db.getService(service.id);
        if (!currentService || currentService.status === "paused") {
          log("health", `skipping auto-restart of ${instance.container_name}: service status is ${currentService?.status ?? "gone"}`);
          return;
        }
        log("health", `auto-restarting service ${instance.container_name}`);
        try {
          if (isCompose) {
            await restartCompose(server.ipv4, instance.container_name, hostKey, SERVICE_COMPOSE_DIR);
          } else {
            await restartContainer(server.ipv4, instance.container_name, hostKey);
          }
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
      db.updateReplicaMetrics(replica.id, stats.cpu, stats.mem);
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
      db.updateServiceInstanceMetrics(instance.id, stats.cpu, stats.mem);
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

  // --- Phase 2: Health checks in parallel for all containers on this server ---
  const healthChecks: Promise<void>[] = [];

  for (const { replica, app } of work.replicas) {
    if (replica.status === "stopped" || replica.status === "paused" || replica.status === "sleeping" || replica.status === "waking") continue;
    healthChecks.push(checkReplicaHealth(replica, app, server));
  }

  for (const { instance, service } of work.serviceInstances) {
    if (instance.status === "paused" || instance.status === "stopped") continue;
    healthChecks.push(checkServiceInstanceHealth(instance, service, server));
  }

  await Promise.all(healthChecks);
}

// ---------------------------------------------------------------------------
// Stuck-state sweep
// ---------------------------------------------------------------------------

const STUCK_COMPENSATING_MIN = 5;
const STUCK_PENDING_RUNNING_MIN = 10;
const MAX_COMPENSATION_ATTEMPTS = 5;

function sweepStuckStates(): void {
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

      if (app.autoscale_enabled) {
        try {
          await evaluateAutoScale(appId);
        } catch (err) {
          log("autoscale", `app ${appId}: ${err}`);
        }
      }
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
