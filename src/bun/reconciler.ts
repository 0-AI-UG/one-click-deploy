import * as db from "./db.ts";
import * as hetzner from "./hetzner/index.ts";
import { evaluateAutoScale } from "./scale.ts";

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

async function tick(): Promise<void> {
  if (running) {
    log("tick", "skip (previous tick still running)");
    return;
  }
  running = true;
  const start = Date.now();
  try {
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

    db.pruneOldMetrics(METRICS_RETENTION_SEC);
    log("tick", `done in ${Date.now() - start}ms (${byApp.size} apps)`);
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
