import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { getComputeProvider, getDnsProvider } from "../../shared/providers/index.ts";
import {
  sshExec,
  removeContainer,
  removeCompose,
  removeAuthProxy,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  restartCompose,
  pauseCompose,
  unpauseCompose,
  composeHealthCheck,
  healthCheck,
  describeFailure,
} from "../../shared/remote/index.ts";
import { removeAppCaddy, syncAppCaddy } from "../scale/caddy-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import * as github from "../../shared/github.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function destroyApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("destroyApp", `Destroying app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) {
      log("destroyApp", `App id=${appId} not found`);
      throw new Error("App not found");
    }

    let cleanupFailed = false;

    // Clean up GitHub webhook if enabled
    if (app.webhook_enabled && app.github_webhook_id) {
      try {
        const pat = await github.getGitHubPat(app.deployed_by || undefined);
        if (pat) {
          await github.deleteWebhook({
            gitRepo: app.git_repo,
            webhookId: app.github_webhook_id,
            token: pat,
          });
        }
      } catch (err) {
        log("destroyApp", `Failed to delete GitHub webhook: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Destroy all replicas across all servers, tracking which servers we touched
    const replicas = db.getReplicas(appId);
    const affectedServerIds = new Set<number>();
    for (const replica of replicas) {
      affectedServerIds.add(replica.server_id);
      const replicaServer = db.getServer(replica.server_id);
      if (replicaServer) {
        const hostKey = replicaServer.ssh_host_key || undefined;
        try {
          if (app.deploy_mode === "compose" && replica.container_name === app.name) {
            await removeCompose(replicaServer.ipv4, app.name, true, hostKey);
          } else {
            await removeContainer(replicaServer.ipv4, replica.container_name, hostKey);
          }
        } catch (err) {
          log("destroyApp", `Failed to remove replica ${replica.container_name}: ${err}`);
          cleanupFailed = true;
        }
        // Remove auth proxy for this replica if present
        if (app.auth_password) {
          try {
            await removeAuthProxy(replicaServer.ipv4, replica.container_name, hostKey);
          } catch (e) {
            log("destroyApp", `Failed to remove auth proxy for ${replica.container_name}: ${e}`);
          }
        }
        // App directories live on the tenant server. Caddy routes are
        // removed from the panel server once, after this loop.
        try {
          await sshExec(replicaServer.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
        } catch (err) {
          log("destroyApp", `Failed to remove app directory: ${err}`);
        }
      }
      db.deleteReplica(replica.id);
    }

    // Remove the app's Caddy vhost from the panel ingress.
    try {
      await removeAppCaddy(app.name, app.domain);
    } catch (err) {
      log("destroyApp", `Failed to remove panel Caddy route: ${err}`);
    }

    const dnsRecords = db.getDnsRecords(appId);
    const dns = getDnsProvider();
    for (const record of dnsRecords) {
      try {
        await dns.deleteRecord({
          zoneId: record.zone_id,
          name: record.name,
          type: record.type,
          value: record.value,
        });
      } catch (err) {
        log("destroyApp", `Failed to delete DNS record ${record.name}/${record.type}:`, err instanceof Error ? err.message : err);
        cleanupFailed = true;
      }
    }

    // Delete volume if attached
    if (app.volume_id) {
      try {
        const firstServer = replicas.length > 0 ? db.getServer(replicas[0].server_id) : null;
        const compute = getComputeProvider(firstServer?.provider);
        await compute.volumes?.delete(app.volume_id);
        log("destroyApp", `Deleted volume ${app.volume_id}`);
      } catch (err) {
        log("destroyApp", `Failed to delete volume ${app.volume_id}:`, err instanceof Error ? err.message : err);
        cleanupFailed = true;
      }
    }

    if (cleanupFailed) {
      db.updateAppStatus(appId, "cleanup_failed");
      log("destroyApp", `App id=${appId} has resources that could not be cleaned up`);
      return { ok: false, error: "Some resources could not be cleaned up. App marked as cleanup_failed." };
    }

    db.deleteApp(appId);

    // GC any servers that became empty as a result.
    for (const sid of affectedServerIds) {
      try { await db.gcServerIfEmpty(sid); } catch (err) {
        log("destroyApp", `gcServerIfEmpty(${sid}) failed: ${err}`);
      }
    }

    log("destroyApp", `App id=${appId} destroyed successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("destroyApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function destroyServer(serverId: number): Promise<{ ok: boolean; error?: string }> {
  log("destroyServer", `Destroying server id=${serverId}`);
  try {
    if (db.getPanel()?.server_id === serverId) {
      throw new Error("Cannot destroy the panel's server");
    }
    const server = db.getServer(serverId);
    if (!server) throw new Error("Server not found");

    const apps = db.getApps(server.org_id, serverId);
    for (const app of apps) {
      await destroyApp(app.id);
    }

    // If this server hosts the self-deployed panel, clean up its DNS record
    // and volume too. The panel lives in its own table (not `apps`), so the
    // loop above wouldn't touch it. Note: if the panel is destroying the
    // server it's running on, it will `docker rm` itself mid-request — so
    // these cleanups MUST run before deleteServer.
    const panel = db.getPanel();
    if (panel && panel.server_id === serverId) {
      if (panel.dns_zone_id && panel.dns_name && panel.dns_type && panel.dns_value) {
        try {
          const dns = getDnsProvider();
          await dns.deleteRecord({
            zoneId: panel.dns_zone_id,
            name: panel.dns_name,
            type: panel.dns_type,
            value: panel.dns_value,
          });
          log("destroyServer", `Deleted panel DNS record ${panel.dns_name}/${panel.dns_type}`);
        } catch (err) {
          log("destroyServer", `Failed to delete panel DNS record:`, err instanceof Error ? err.message : err);
        }
      }
      if (panel.volume_id) {
        try {
          const compute = getComputeProvider(server.provider);
          await compute.volumes?.delete(panel.volume_id);
          log("destroyServer", `Deleted panel volume ${panel.volume_id}`);
        } catch (err) {
          log("destroyServer", `Failed to delete panel volume ${panel.volume_id}:`, err instanceof Error ? err.message : err);
        }
      }
      // The panel row will cascade-delete via FK when the server row goes,
      // but clear it explicitly for clarity.
      db.deletePanel();
    }

    const compute = getComputeProvider(server.provider);
    await compute.deleteServer(server.provider_id);
    db.deleteServer(serverId);
    log("destroyServer", `Server id=${serverId} destroyed successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("destroyServer", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function restartApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("restartApp", `Restarting app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");

    let allHealthy = true;
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await restartCompose(server.ipv4, app.name, hostKey);
      } else {
        await restartContainer(server.ipv4, replica.container_name, hostKey);
      }

      const bindAddr = replicaBindHost(server);
      const health = app.deploy_mode === "compose" && replica.container_name === app.name
        ? await composeHealthCheck(server.ipv4, app.name, bindAddr, replica.host_port, 5, hostKey)
        : await healthCheck(server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey);
      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }
    db.updateAppStatus(appId, allHealthy ? "running" : "unhealthy");

    log("restartApp", `App id=${appId} restarted`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("restartApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function recreateAppContainer(
  appId: number,
  volumeMount: string | undefined,
  extraVolumes?: string[]
): Promise<{ ok: boolean; error?: string }> {
  log("recreateContainer", `Recreating container for app id=${appId} volumeMount=${volumeMount || "none"}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const firstReplica = replicas[0];
    const server = db.getServer(firstReplica.server_id);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const hostPort = firstReplica.host_port;
    const bindAddr = replicaBindHost(server);

    if (app.deploy_mode === "compose") {
      // Rewrite the compose override to update volume mount
      const appDir = `/home/deploy/apps/${app.name}`;
      const overrideServices: Record<string, { ports: string[]; volumes?: string[] }> = {
        [app.compose_web_service]: {
          ports: [`${bindAddr}:${hostPort}:${app.container_port}`],
        },
      };
      const allVols = [
        ...(volumeMount ? [volumeMount] : []),
        ...(extraVolumes || []),
      ];
      if (allVols.length > 0) {
        overrideServices[app.compose_web_service].volumes = allVols;
      }
      const override = JSON.stringify({ services: overrideServices });
      const escapedOverride = override.replace(/'/g, "'\\''");
      await sshExec(server.ipv4, `echo '${escapedOverride}' > ${appDir}/docker-compose.ocd.yml && chown deploy:deploy ${appDir}/docker-compose.ocd.yml`, hostKey);

      // Restart compose (no rebuild)
      const envFilePath = `${appDir}/.env.deploy`;
      const envFileFlag = app.env_vars && app.env_vars !== "{}" ? `--env-file ${envFilePath}` : "";
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d`;
      await sshExec(server.ipv4, asUser(composeCmd), hostKey);
    } else {
      // Dockerfile mode: rm + run with updated flags
      await removeContainer(server.ipv4, app.name, hostKey);

      const envVars = await resolveAppEnvVars(app);
      const envFileEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envFileEntries.length > 0) {
        const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
        envFileFlag = `--env-file ${envFilePath}`;
      }

      const volumeFlag = volumeMount ? `-v ${volumeMount}` : "";
      const extraVolFlags = (extraVolumes || []).map((v) => `-v ${v}`).join(" ");
      const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${extraVolFlags} ${app.name}:latest`;
      const result = await sshExec(server.ipv4, asUser(cmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error(describeFailure("Failed to start container", result));
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, app.name, bindAddr, hostPort, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");
    db.updateReplicaStatus(firstReplica.id, health.healthy ? "running" : "unhealthy");

    log("recreateContainer", `App id=${appId} recreated successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("recreateContainer", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function pauseApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("pauseApp", `Pausing app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");

    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await pauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await pauseContainer(server.ipv4, replica.container_name, hostKey);
      }
      db.updateReplicaStatus(replica.id, "paused");
    }

    db.updateAppStatus(appId, "paused");
    // Drop the paused replicas from the Caddy upstream pool so external
    // traffic gets a clean 503 instead of flapping through the passive
    // health-check window on a frozen TCP-accepting-but-not-serving
    // backend.
    try {
      await syncAppCaddy(appId);
    } catch (err) {
      log("pauseApp", `syncAppCaddy after pause failed (non-fatal): ${err}`);
    }
    log("pauseApp", `App id=${appId} paused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("pauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function unpauseApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("unpauseApp", `Unpausing app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");

    let allHealthy = true;
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await unpauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await unpauseContainer(server.ipv4, replica.container_name, hostKey);
      }

      const bindAddr = replicaBindHost(server);
      const health = app.deploy_mode === "compose" && replica.container_name === app.name
        ? await composeHealthCheck(server.ipv4, app.name, bindAddr, replica.host_port, 5, hostKey)
        : await healthCheck(server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey);
      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }
    db.updateAppStatus(appId, allHealthy ? "running" : "unhealthy");
    // Re-add the replicas to the Caddy upstream pool now that they're
    // live again. The reconciler would pick this up within 30s anyway,
    // but waiting means the first requests after unpause hit stale 503s.
    try {
      await syncAppCaddy(appId);
    } catch (err) {
      log("unpauseApp", `syncAppCaddy after unpause failed (non-fatal): ${err}`);
    }

    log("unpauseApp", `App id=${appId} unpaused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("unpauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}
