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
  transferImage,
  pullImmutableImage,
} from "../../shared/remote/index.ts";
import { syncAllTraefik, syncAppIngress } from "../scale/traefik-manager.ts";
import { replicaBindHost, appReplicaRunOpts } from "../scale/types.ts";
import * as github from "../../shared/github.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";

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

    // Delete volume if attached. A volume ATTACHED via attach_existing_volume
    // predates us (may hold data we don't own), so it is detached-not-deleted.
    if (app.volume_id) {
      try {
        const compute = hetzner;
        if (app.volume_attached) {
          await compute.volumes?.detach(app.volume_id);
          log("destroyApp", `Detached pre-existing volume ${app.volume_id}`);
        } else {
          await compute.volumes?.detach(app.volume_id);
          db.retireVolume({
            providerVolumeId: app.volume_id,
            formerResourceType: "app",
            formerResourceId: app.id,
            formerResourceName: app.name,
            reason: "app destroyed through server cleanup",
          });
          log("destroyApp", `Detached volume ${app.volume_id}; retained for recovery for 7 days`);
        }
      } catch (err) {
        log("destroyApp", `Failed to release volume ${app.volume_id}:`, err instanceof Error ? err.message : err);
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

/**
 * Recreate every replica from its recorded immutable image with freshly
 * resolved environment variables. This applies config changes without
 * cloning/building source and keeps the ordinary restart command's lighter
 * docker-restart semantics separate.
 */
export async function reloadAppEnvironment(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("reloadAppEnvironment", `Reloading app id=${appId} from existing image`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const envVars = await resolveAppEnvVars(app);
    const desiredImage = latestDesiredImage(app);
    const desiredDeployment = db.getDeployments(app.id).find((d) => d.status === "deployed");
    if (!desiredDeployment?.image_digest && !app.image_ref) {
      throw new Error("No immutable deployed image is recorded; run a full deploy once before reloading the environment");
    }
    const expected = {
      imageDigest: desiredDeployment?.image_digest || app.image_ref,
      envHash: hashEnvironment(envVars),
      configRevision: app.config_revision,
    };
    const registryToken = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
    let allHealthy = true;

    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) {
        allHealthy = false;
        continue;
      }
      if (replicas.length > 1) {
        db.updateReplicaStatus(replica.id, "draining");
        await syncAppIngress(appId).catch(() => {});
      }
      const present = await sshExec(
        server.ipv4,
        `su - deploy -c ${JSON.stringify(`docker image inspect ${desiredImage} >/dev/null 2>&1 && echo yes || echo no`)}`,
        server.ssh_host_key || undefined,
      );
      if (present.stdout.trim() !== "yes") {
        if (desiredImage.includes("@sha256:")) {
          await pullImmutableImage(server.ipv4, {
            name: app.name,
            imageRef: desiredImage,
            gitToken: registryToken,
            hostKey: server.ssh_host_key || undefined,
          });
        } else {
          const source = replicas
            .map((candidate) => ({ candidate, host: db.getServer(candidate.server_id) }))
            .find(({ host }) => host && host.id !== server.id);
          if (!source?.host) throw new Error(`Immutable image ${desiredImage} is missing and no replica can supply it`);
          await transferImage(
            source.host.ipv4,
            server.ipv4,
            desiredImage,
            source.host.ssh_host_key || undefined,
            server.ssh_host_key || undefined,
            {
              registryRef: app.build_cache_ref || undefined,
              registryToken,
              allowArchiveFallback: db.getSettings().allow_archive_image_transfer === "1",
              onProgress: (line) => log("reloadAppEnvironment", line),
            },
          );
        }
      }
      await startAppReplica(
        server.ipv4,
        appReplicaRunOpts(app, server, {
          containerName: replica.container_name,
          hostPort: replica.host_port,
          envVars,
        }),
        server.ssh_host_key || undefined,
      );
      const bindAddr = replicaBindHost(server);
      const health = await probeAppHealth(
        app,
        server.ipv4,
        replica.container_name,
        bindAddr,
        replica.host_port,
        5,
        server.ssh_host_key || undefined,
      );
      if (!health.healthy) {
        db.updateReplicaStatus(replica.id, "unhealthy");
        allHealthy = false;
      } else {
        db.updateReplicaStatus(replica.id, "attesting");
        const attestation = await attestReplica(app, replica, server, expected);
        if (!attestation.ok) allHealthy = false;
        else db.updateReplicaStatus(replica.id, "running");
      }
      await syncAppIngress(appId).catch(() => {});
    }
    db.updateAppStatus(appId, allHealthy ? "running" : "unhealthy");
    if (!allHealthy) throw new Error("One or more replicas were unhealthy or divergent after environment reload");
    db.markAppEnvironmentFresh(appId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("reloadAppEnvironment", `Failed: ${msg}`);
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
    const desiredImage = latestDesiredImage(app);

    // Recreate through the shared hardened path. The previous hand-built
    // `docker run` here skipped cap-drop / no-new-privileges / mem-cpu-pids
    // ceilings and did no allowlist validation of the interpolated -v flags;
    // buildDockerRunArgs (via startAppReplica) applies all of them. Use the
    // same ocd-net attachment as initial deploys and environment reloads.
    await startAppReplica(server.ipv4, {
      containerName: firstReplica.container_name,
      image: desiredImage,
      appName: app.name,
      network: "ocd-net",
      bindAddr,
      hostPort,
      containerPort: app.container_port,
      envVars,
      configRevision: app.config_revision,
      envHash: hashEnvironment(envVars),
      volumeMount: volumeMount || undefined,
      extraVolumes: extraVolumes || [],
      memoryMb: app.memory_mb || undefined,
      cpus: app.cpu_limit || undefined,
    }, hostKey);

    // Health check (running-only when the app opted out of the HTTP probe)
    const health = await probeAppHealth(app, server.ipv4, firstReplica.container_name, bindAddr, hostPort, 5, hostKey);
    if (!health.healthy) {
      db.updateAppStatus(appId, "unhealthy");
      db.updateReplicaStatus(firstReplica.id, "unhealthy");
      throw new Error("Recreated container did not become healthy");
    }
    db.updateReplicaStatus(firstReplica.id, "attesting");
    const expected = {
      imageDigest: desiredImage,
      envHash: hashEnvironment(envVars),
      configRevision: app.config_revision,
    };
    const attestation = await attestReplica(app, firstReplica, server, expected);
    if (!attestation.ok) throw new Error(`Recreated container attestation failed: ${attestation.error}`);
    db.updateAppStatus(appId, "running");
    db.updateReplicaStatus(firstReplica.id, "running");

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
