import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, healthCheck, containerRunningCheck, deployAuthProxy,
  startContainer, containerExists,
  buildDockerRunArgs,
} from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { log, replicaBindHost } from "./types.ts";

export async function wakeApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("wake", `Waking app ${appId}`);

  try {
    const app = db.getApp(appId);
    if (!app) return { ok: false, error: "App not found" };
    if (app.status !== "sleeping") return { ok: true }; // already awake or waking

    const serverId = app.sleeping_server_id;
    const hostPort = app.sleeping_host_port;
    if (!serverId || !hostPort) return { ok: false, error: "Missing sleeping state" };

    const server = db.getServer(serverId);
    if (!server) return { ok: false, error: "Server not found" };

    db.updateAppStatus(appId, "waking");

    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const containerName = app.name;

    // Prefer the fast path: if the replica was preserved on disk by
    // scale-down (Phase 0), the container still exists and we can bring it
    // back up with `docker start` in ~1s instead of a fresh `docker run`
    // that has to (re)create everything.
    let startedFastPath = false;
    if (await containerExists(server.ipv4, containerName, hostKey)) {
      try {
        const ok = await startContainer(server.ipv4, containerName, hostKey);
        if (ok) {
          startedFastPath = true;
          log("wake", `App ${appId}: light wake via 'docker start'`);
        }
      } catch (err) {
        log("wake", `docker start failed, falling back to 'docker run': ${err}`);
      }
    }

    const bindAddr = replicaBindHost(server);

    // Slow path: full re-run. Only taken when the container is not on disk —
    // e.g. a pre-Phase-0 sleep where scale-down did `docker rm -f`, or manual
    // cleanup on the tenant host.
    if (!startedFastPath) {
      const envVars = await resolveAppEnvVars(app);
      const envFilePath = Object.keys(envVars).length > 0
        ? `/home/deploy/apps/${app.name}/.env.deploy`
        : undefined;
      let wakeExtraVols: string[] = [];
      try { const ev = JSON.parse(app.extra_volumes); if (Array.isArray(ev)) wakeExtraVols = ev.filter((v: unknown): v is string => typeof v === "string"); } catch {}
      const cmd = buildDockerRunArgs({
        name: containerName,
        image: `${app.name}:latest`,
        appName: app.name,
        network: null,
        publish: { bindAddr, hostPort, containerPort: app.container_port },
        envFilePath,
        volumeMount: app.volume_mount || undefined,
        extraVolumes: wakeExtraVols,
        memoryMb: app.memory_mb || undefined,
      });
      await sshExec(server.ipv4, asUser(cmd), hostKey);
    }

    // Health check (running-only when the app opted out of the HTTP probe)
    const health = app.health_check
      ? await healthCheck(server.ipv4, containerName, bindAddr, hostPort, 5, hostKey)
      : await containerRunningCheck(server.ipv4, containerName, 5, hostKey);

    // Re-deploy auth proxy only on the slow path. The fast path preserved
    // the auth proxy systemd unit when the container was stopped.
    if (app.auth_password && !startedFastPath) {
      await deployAuthProxy(server.ipv4, containerName, app.auth_password, hostPort, bindAddr, hostKey);
    }

    // Upsert the replica row. On the fast path a preserved row already
    // exists (status = 'stopped') — flip it back to running. On the slow
    // path (no preserved row) insert fresh.
    const preserved = db
      .getReplicasByServer(serverId)
      .find((r) => r.app_id === appId && r.container_name === containerName);
    if (preserved) {
      if (health.healthy) {
        db.markReplicaRunning(preserved.id);
      } else {
        db.updateReplicaStatus(preserved.id, "unhealthy");
      }
    } else {
      db.insertReplica({
        app_id: appId,
        server_id: serverId,
        host_port: hostPort,
        container_name: containerName,
        status: health.healthy ? "running" : "unhealthy",
      });
    }

    // Clear sleeping state
    db.clearAppSleepingState(appId);
    db.updateAppScaling(appId, { desired_replicas: 1, last_scale_at: new Date().toISOString() });
    db.updateAppStatus(appId, "running");
    db.insertScalingEvent({ app_id: appId, event_type: "wake", from_count: 0, to_count: 1, reason: "wake request" });

    // Re-render ingress so public traffic is routed back to the replica —
    // the desired-state render replaces the wake-page routing (domain →
    // panel) with the app's upstream pool now that the app is running.
    try {
      await syncAppIngress(appId);
    } catch (err) {
      log("wake", `syncAppIngress after wake failed: ${err}`);
    }

    log("wake", `App ${appId} woken successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("wake", `Failed to wake app ${appId}: ${msg}`);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}
