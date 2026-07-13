import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import {
  sshExec,
  removeContainer,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  probeAppHealth,
  startAppReplica,
} from "../../shared/remote/index.ts";
import { syncAllTraefik, syncAppIngress } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import * as github from "../../shared/github.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

// Single imperative teardown for an app. The destroy_server cascade drives this
// directly; the standalone destroy_app op reimplements the same steps as a saga
// (see ops/destroy-app.ts).
export async function destroyAppCore(appId: number): Promise<{ ok: boolean; error?: string }> {
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
          await removeContainer(replicaServer.ipv4, replica.container_name, hostKey);
        } catch (err) {
          log("destroyApp", `Failed to remove replica ${replica.container_name}: ${err}`);
          cleanupFailed = true;
        }
        // App directories live on the tenant server. Ingress routes are
        // removed from the panel server once, after this loop.
        try {
          await sshExec(replicaServer.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
        } catch (err) {
          log("destroyApp", `Failed to remove app directory: ${err}`);
        }
      }
      db.deleteReplica(replica.id);
    }

    // Re-render the fleet ingress config: with the replica rows gone above the
    // app's routers simply disappear from the desired-state render.
    try {
      await syncAllTraefik();
    } catch (err) {
      log("destroyApp", `Failed to remove panel ingress route: ${err}`);
    }

    const dnsRecords = db.getDnsRecords(appId);
    const dns = hetznerDns;
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
        const compute = hetzner;
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

/** @deprecated Kept as a stable name for the deploy/index.ts re-export. */
export const destroyApp = destroyAppCore;

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

      await restartContainer(server.ipv4, replica.container_name, hostKey);

      const bindAddr = replicaBindHost(server);
      const health = await probeAppHealth(app, server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey);
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
    const hostPort = firstReplica.host_port;
    const bindAddr = replicaBindHost(server);

    const envVars = await resolveAppEnvVars(app);
    const envFilePath = Object.keys(envVars).length > 0
      ? `/home/deploy/apps/${app.name}/.env.deploy`
      : undefined;

    // Recreate through the shared hardened path. The previous hand-built
    // `docker run` here skipped cap-drop / no-new-privileges / mem-cpu-pids
    // ceilings and did no allowlist validation of the interpolated -v flags;
    // buildDockerRunArgs (via startAppReplica) applies all of them. network:null
    // preserves the historical default-bridge attachment for this container.
    await startAppReplica(server.ipv4, {
      containerName: app.name,
      image: `${app.name}:latest`,
      appName: app.name,
      network: null,
      bindAddr,
      hostPort,
      containerPort: app.container_port,
      envFilePath,
      volumeMount: volumeMount || undefined,
      extraVolumes: extraVolumes || [],
      memoryMb: app.memory_mb || undefined,
      cpus: app.cpu_limit || undefined,
    }, hostKey);

    // Health check (running-only when the app opted out of the HTTP probe)
    const health = await probeAppHealth(app, server.ipv4, app.name, bindAddr, hostPort, 5, hostKey);
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

    // Zero replicas (never deployed or torn down) is not an error — there is
    // nothing to freeze, but the desired state should still be recorded.
    const replicas = db.getReplicas(appId);

    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      await pauseContainer(server.ipv4, replica.container_name, hostKey);
      db.updateReplicaStatus(replica.id, "paused");
    }

    db.updateAppStatus(appId, "paused");
    // Drop the paused replicas from the ingress upstream pool so external
    // traffic gets a clean 503 instead of flapping through the passive
    // health-check window on a frozen TCP-accepting-but-not-serving
    // backend.
    try {
      await syncAppIngress(appId);
    } catch (err) {
      log("pauseApp", `syncAppIngress after pause failed (non-fatal): ${err}`);
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

    let allHealthy = true;
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;

      await unpauseContainer(server.ipv4, replica.container_name, hostKey);

      const bindAddr = replicaBindHost(server);
      const health = await probeAppHealth(app, server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey);
      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }
    // With no replicas there is nothing running — "stopped", not "running".
    db.updateAppStatus(appId, replicas.length === 0 ? "stopped" : allHealthy ? "running" : "unhealthy");
    // Re-add the replicas to the ingress upstream pool now that they're
    // live again. The reconciler would pick this up within 30s anyway,
    // but waiting means the first requests after unpause hit stale 503s.
    try {
      await syncAppIngress(appId);
    } catch (err) {
      log("unpauseApp", `syncAppIngress after unpause failed (non-fatal): ${err}`);
    }

    log("unpauseApp", `App id=${appId} unpaused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("unpauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}
