import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, composeHealthCheck, healthCheck, deployAuthProxy,
  startContainer, startCompose, containerExists, composeProjectExists,
  removeCaddyWakePage,
} from "../../shared/remote/index.ts";
import { syncAppCaddy } from "./caddy-manager.ts";
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
    // scale-down (Phase 0), the container/compose project still exists and
    // we can bring it back up with `docker start` in ~1s instead of a fresh
    // `docker run` that has to (re)create everything.
    let startedFastPath = false;
    if (app.deploy_mode === "compose") {
      if (await composeProjectExists(server.ipv4, app.name, hostKey)) {
        try {
          await startCompose(server.ipv4, app.name, hostKey);
          startedFastPath = true;
          log("wake", `App ${appId}: light wake via 'docker compose start'`);
        } catch (err) {
          // Fall through to the slow path (full `compose up -d`). The
          // compose stack may have been removed out-of-band.
          log("wake", `compose start failed, falling back to 'compose up -d': ${err}`);
        }
      }
    } else {
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
    }

    const bindAddr = replicaBindHost(server);

    // Slow path: full re-run. Only taken when the container/compose project
    // is not on disk — e.g. a pre-Phase-0 sleep where scale-down did
    // `docker rm -f`, or manual cleanup on the tenant host.
    if (!startedFastPath) {
      if (app.deploy_mode === "compose") {
        await sshExec(server.ipv4, asUser(
          `cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`
        ), hostKey);
      } else {
        const envVars = await resolveAppEnvVars(app);
        let envFileFlag = "";
        if (Object.keys(envVars).length > 0) {
          envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
        }
        const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
        let wakeExtraVolFlags = "";
        try { const ev = JSON.parse(app.extra_volumes); if (Array.isArray(ev)) wakeExtraVolFlags = ev.map((v: string) => `-v ${v}`).join(" "); } catch {}
        const cmd = `docker run -d --name ${containerName} --restart unless-stopped ` +
          `-p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${wakeExtraVolFlags} ${app.name}:latest`;
        await sshExec(server.ipv4, asUser(cmd), hostKey);
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, containerName, bindAddr, hostPort, 5, hostKey);

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

    // Reinstall the panel Caddy vhost so public traffic is routed back to
    // the replica (instead of the wake page that was serving 503s while
    // the app was asleep).
    try {
      await syncAppCaddy(appId);
    } catch (err) {
      log("wake", `syncAppCaddy after wake failed: ${err}`);
    }

    // The wake page route lives in srv0/routes under a different @id than
    // the app route (`ocd-<domain>` vs `ocd-app-<name>`). syncAppCaddy
    // doesn't touch it; since wake-page is `terminal: true` and was POSTed
    // first, it would keep shadowing the app route after wake. Drop it.
    try {
      const panel = db.getPanel();
      const panelServer = panel ? db.getServer(panel.server_id) : null;
      if (panelServer?.ipv4 && app.domain) {
        await removeCaddyWakePage(panelServer.ipv4, app.domain, panelServer.ssh_host_key || undefined);
      }
    } catch (err) {
      log("wake", `removeCaddyWakePage after wake failed: ${err}`);
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
