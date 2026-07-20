import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  probeAppHealth, startAppReplica,
  startContainer, containerExists,
} from "../../shared/remote/index.ts";
import { pushProxyForApp } from "./proxy-manager.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { log, replicaBindHost, appReplicaRunOpts } from "./types.ts";

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
      // The container provably doesn't exist here (fast path failed), so skip
      // the rm -f round-trip.
      await startAppReplica(server.ipv4, {
        ...appReplicaRunOpts(app, server, { containerName, hostPort, envFilePath }),
        removeExisting: false,
      }, hostKey);
    }

    // Health check (running-only when the app opted out of the HTTP probe)
    const health = await probeAppHealth(app, server.ipv4, containerName, bindAddr, hostPort, 5, hostKey);

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
    // Restart the request-idle window: the pre-sleep last_request_at is by
    // definition older than the sleep threshold, so without this the idle
    // monitor would re-sleep the app on its next tick.
    db.touchAppLastRequest(appId);
    db.updateAppStatus(appId, "running");
    db.insertScalingEvent({ app_id: appId, event_type: "wake", from_count: 0, to_count: 1, reason: "wake request" });

    // Re-render ingress so traffic is routed back to the replica — the
    // desired-state render replaces the waker routing (every router → panel
    // waker) with the app's real upstream pool now that the app is running.
    try {
      await syncAppIngress(appId);
    } catch (err) {
      log("wake", `syncAppIngress after wake failed: ${err}`);
    }
    // Same immediacy for the fleet ocd-proxy: internal VIP traffic must reach
    // the woken replica now, not after the next 30s reconciler tick.
    // Best-effort; pushProxyForApp never throws.
    await pushProxyForApp(appId);

    log("wake", `App ${appId} woken successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("wake", `Failed to wake app ${appId}: ${msg}`);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}
