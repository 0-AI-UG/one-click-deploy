import * as db from "../db.ts";
import { sshExec, composeHealthCheck, healthCheck, deployAuthProxy, authProxyPort, deployCaddySite } from "../remote/index.ts";
import { log } from "./types.ts";

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

    // Start container
    if (app.deploy_mode === "compose") {
      await sshExec(server.ipv4, asUser(
        `cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`
      ), hostKey);
    } else {
      const envVars = JSON.parse(app.env_vars || "{}");
      let envFileFlag = "";
      if (Object.keys(envVars).length > 0) {
        envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
      }
      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const cmd = `docker run -d --name ${containerName} --restart unless-stopped ` +
        `-p 127.0.0.1:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
      await sshExec(server.ipv4, asUser(cmd), hostKey);
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, containerName, hostPort, 5, hostKey);

    // Re-deploy auth proxy if needed
    if (app.auth_password) {
      await deployAuthProxy(server.ipv4, containerName, app.auth_password, hostPort, hostKey);
    }

    // Restore Caddy reverse proxy route
    const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
    const caddyPort = app.auth_password ? authProxyPort(hostPort) : hostPort;
    await deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls, hostKey);

    // Insert replica record
    db.insertReplica({
      app_id: appId,
      server_id: serverId,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "running" : "unhealthy",
    });

    // Clear sleeping state
    db.clearAppSleepingState(appId);
    db.updateAppScaling(appId, { desired_replicas: 1, last_scale_at: new Date().toISOString() });
    db.updateAppStatus(appId, "running");
    db.insertScalingEvent({ app_id: appId, event_type: "wake", from_count: 0, to_count: 1, reason: "wake request" });

    log("wake", `App ${appId} woken successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("wake", `Failed to wake app ${appId}: ${msg}`);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}
