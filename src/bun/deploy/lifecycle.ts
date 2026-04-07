import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import * as github from "../github.ts";

function log(context: string, ...args: any[]) {
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

    const server = db.getServer(app.server_id);
    let cleanupFailed = false;

    // Clean up GitHub webhook if enabled
    if (app.webhook_enabled && app.github_webhook_id) {
      try {
        const pat = await github.getGitHubPat();
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

    // Destroy all replicas across all servers
    const replicas = db.getReplicas(appId);
    for (const replica of replicas) {
      const replicaServer = db.getServer(replica.server_id);
      if (replicaServer) {
        const hostKey = replicaServer.ssh_host_key || undefined;
        try {
          if (app.deploy_mode === "compose" && replica.container_name === app.name) {
            await hetzner.removeCompose(replicaServer.ipv4, app.name, true, hostKey);
          } else {
            await hetzner.removeContainer(replicaServer.ipv4, replica.container_name, hostKey);
          }
        } catch (err) {
          log("destroyApp", `Failed to remove replica ${replica.container_name}: ${err}`);
          cleanupFailed = true;
        }
        // Remove auth proxy for this replica if present
        if (app.auth_password) {
          try {
            await hetzner.removeAuthProxy(replicaServer.ipv4, replica.container_name, hostKey);
          } catch {}
        }
      }
      db.deleteReplica(replica.id);
    }

    // Delete LB if present
    if (app.hetzner_lb_id) {
      try {
        await hetzner.deleteLoadBalancer(app.hetzner_lb_id);
        log("destroyApp", `Deleted load balancer ${app.hetzner_lb_id}`);
      } catch (err) {
        log("destroyApp", `Failed to delete LB: ${err instanceof Error ? err.message : err}`);
        cleanupFailed = true;
      }
    }

    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      // Remove webhook config from server
      if (app.webhook_enabled) {
        try {
          await hetzner.removeAppWebhook(server.ipv4, app.name, hostKey);
        } catch (err) {
          log("destroyApp", `Failed to remove webhook config: ${err}`);
        }
      }
      // Remove primary container (if not already removed as replica)
      if (replicas.length === 0) {
        if (app.auth_password) {
          try {
            await hetzner.removeAuthProxy(server.ipv4, app.name, hostKey);
          } catch {}
        }
        try {
          if (app.deploy_mode === "compose") {
            await hetzner.removeCompose(server.ipv4, app.name, true, hostKey);
          } else {
            await hetzner.removeContainer(server.ipv4, app.name, hostKey);
          }
        } catch (err) {
          log("destroyApp", `Failed to remove primary container: ${err}`);
          cleanupFailed = true;
        }
      }
      try {
        await hetzner.removeCaddySite(server.ipv4, app.domain, hostKey);
      } catch (err) {
        log("destroyApp", `Failed to remove Caddy site: ${err}`);
      }
      try {
        await hetzner.sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
      } catch (err) {
        log("destroyApp", `Failed to remove app directory: ${err}`);
      }
    }

    const dnsRecords = db.getDnsRecords(appId);
    for (const record of dnsRecords) {
      try {
        await hetzner.deleteDnsRecord({
          zone_id: record.zone_id,
          name: record.name,
          type: record.type,
          value: record.value,
        });
      } catch (err) {
        log("destroyApp", `Failed to delete DNS record ${record.name}/${record.type}:`, err instanceof Error ? err.message : err);
        cleanupFailed = true;
      }
    }

    // Delete Hetzner volume if attached
    if (app.volume_id) {
      try {
        await hetzner.deleteVolume(app.volume_id);
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
    const server = db.getServer(serverId);
    if (!server) throw new Error("Server not found");

    const apps = db.getApps(serverId);
    for (const app of apps) {
      await destroyApp(app.id);
    }

    await hetzner.deleteHetznerServer(server.hetzner_id);
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

    // Restart all replicas
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await hetzner.restartCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.restartContainer(server.ipv4, replica.container_name, hostKey);
      }

      const health = app.deploy_mode === "compose" && replica.container_name === app.name
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, replica.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, replica.container_name, replica.host_port, 5, hostKey);
      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
    }

    // Also restart on primary if no replicas found (legacy)
    if (replicas.length === 0) {
      const server = db.getServer(app.server_id);
      if (!server) throw new Error("Server not found");
      const hostKey = server.ssh_host_key || undefined;
      if (app.deploy_mode === "compose") {
        await hetzner.restartCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.restartContainer(server.ipv4, app.name, hostKey);
      }
    }

    const server = db.getServer(app.server_id);
    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      const health = app.deploy_mode === "compose"
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
      db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");
    }

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
  volumeMount: string | undefined
): Promise<{ ok: boolean; error?: string }> {
  log("recreateContainer", `Recreating container for app id=${appId} volumeMount=${volumeMount || "none"}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

    if (app.deploy_mode === "compose") {
      // Rewrite the compose override to update volume mount
      const appDir = `/home/deploy/apps/${app.name}`;
      const overrideServices: any = {
        [app.compose_web_service]: {
          ports: [`127.0.0.1:${app.host_port}:${app.container_port}`],
        },
      };
      if (volumeMount) {
        overrideServices[app.compose_web_service].volumes = [volumeMount];
      }
      const override = JSON.stringify({ services: overrideServices });
      const escapedOverride = override.replace(/'/g, "'\\''");
      await hetzner.sshExec(server.ipv4, `echo '${escapedOverride}' > ${appDir}/docker-compose.ocd.yml && chown deploy:deploy ${appDir}/docker-compose.ocd.yml`, hostKey);

      // Restart compose (no rebuild)
      const envFilePath = `${appDir}/.env.deploy`;
      const envFileFlag = app.env_vars && app.env_vars !== "{}" ? `--env-file ${envFilePath}` : "";
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d`;
      await hetzner.sshExec(server.ipv4, asUser(composeCmd), hostKey);
    } else {
      // Dockerfile mode: rm + run with updated flags
      await hetzner.removeContainer(server.ipv4, app.name, hostKey);

      const envVars = JSON.parse(app.env_vars || "{}");
      const envFileEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envFileEntries.length > 0) {
        const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
        envFileFlag = `--env-file ${envFilePath}`;
      }

      const volumeFlag = volumeMount ? `-v ${volumeMount}` : "";
      const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p 127.0.0.1:${app.host_port}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
      const result = await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to start container — check your port configuration and environment variables");
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
      : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

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

    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await hetzner.pauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.pauseContainer(server.ipv4, replica.container_name, hostKey);
      }
      db.updateReplicaStatus(replica.id, "paused");
    }

    // Legacy fallback
    if (replicas.length === 0) {
      const server = db.getServer(app.server_id);
      if (!server) throw new Error("Server not found");
      const hostKey = server.ssh_host_key || undefined;
      if (app.deploy_mode === "compose") {
        await hetzner.pauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.pauseContainer(server.ipv4, app.name, hostKey);
      }
    }

    db.updateAppStatus(appId, "paused");
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

    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        await hetzner.unpauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.unpauseContainer(server.ipv4, replica.container_name, hostKey);
      }

      const health = app.deploy_mode === "compose" && replica.container_name === app.name
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, replica.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, replica.container_name, replica.host_port, 5, hostKey);
      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
    }

    // Legacy fallback
    if (replicas.length === 0) {
      const server = db.getServer(app.server_id);
      if (!server) throw new Error("Server not found");
      const hostKey = server.ssh_host_key || undefined;
      if (app.deploy_mode === "compose") {
        await hetzner.unpauseCompose(server.ipv4, app.name, hostKey);
      } else {
        await hetzner.unpauseContainer(server.ipv4, app.name, hostKey);
      }
    }

    const server = db.getServer(app.server_id);
    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      const health = app.deploy_mode === "compose"
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
      db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");
    }

    log("unpauseApp", `App id=${appId} unpaused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("unpauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}
