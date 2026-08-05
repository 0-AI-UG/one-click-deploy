import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  pullImmutableImageAndRun, sshExec,
  probeAppHealth, startAppReplica,
  startContainer, containerExists,
} from "../../shared/remote/index.ts";
import { pushProxyForApp } from "./proxy-manager.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { log, replicaBindHost, appReplicaRunOpts } from "./types.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";

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
    const bindAddr = replicaBindHost(server);
    const envVars = await resolveAppEnvVars(app);
    const desiredImage = latestDesiredImage(app);
    const desiredEnvHash = hashEnvironment(envVars);
    const preserved = db
      .getReplicasByServer(serverId)
      .find((r) => r.app_id === appId && r.container_name === containerName);
    const preservedMatches = Boolean(
      preserved?.attested_at &&
      preserved.desired_image_digest === desiredImage &&
      preserved.env_hash === desiredEnvHash &&
      preserved.config_revision === app.config_revision &&
      !preserved.attestation_error
    );

    // Prefer the fast path: if the replica was preserved on disk by
    // scale-down (Phase 0), the container still exists and we can bring it
    // back up with `docker start` in ~1s instead of a fresh `docker run`
    // that has to (re)create everything.
    let startedFastPath = false;
    if (preservedMatches && await containerExists(server.ipv4, containerName, hostKey)) {
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

    // Slow path: full re-run when the container is absent or its attested
    // image/config no longer matches desired state.
    if (!startedFastPath) {
      const githubPat = (await resolveGitHubToken(app.deployed_by)) || undefined;

      if (app.source_mode === "image") {
        if (app.image_ref) {
          // Sleeping may have removed local tags, but immutable artifacts should
          // still be recoverable. Pulling them and retagging to app.name:latest
          // recreates the expected runtime assumptions without requiring local
          // image history to be preserved.
          await pullImmutableImageAndRun(server.ipv4, {
            name: app.name,
            imageRef: app.image_ref,
            port: app.container_port,
            hostPort,
            envVars,
            volumeMount: app.volume_mount || undefined,
            extraVolumes: db.parseExtraVolumes(app.extra_volumes),
            bindAddr,
            memoryMb: app.memory_mb || undefined,
            cpus: app.cpu_limit || undefined,
            gitToken: githubPat,
            hostKey,
            configRevision: app.config_revision,
            envHash: hashEnvironment(envVars),
          });
        } else {
          // Backward compatibility for legacy records that only have a local
          // app.name:latest image tag.
          await startAppReplica(server.ipv4, {
            ...appReplicaRunOpts(app, server, { containerName, hostPort, envVars }),
          }, hostKey);
        }
      } else {
        // A wake is not a source deployment. Reuse the recorded immutable
        // revision; rebuilding a moving branch here could silently wake a
        // different commit under the old deployment record.
        const present = await sshExec(
          server.ipv4,
          `su - deploy -c ${JSON.stringify(`docker image inspect ${desiredImage} >/dev/null 2>&1 && echo yes || echo no`)}`,
          hostKey,
        );
        if (present.stdout.trim() !== "yes") {
          throw new Error(`Immutable image ${desiredImage} is missing; run a full deploy to restore this revision`);
        }
        await startAppReplica(server.ipv4, {
          ...appReplicaRunOpts(app, server, { containerName, hostPort, envVars }),
        }, hostKey);
      }
    }

    // Health check (running-only when the app opted out of the HTTP probe)
    const health = await probeAppHealth(app, server.ipv4, containerName, bindAddr, hostPort, 5, hostKey);

    // Upsert the replica row. On the fast path a preserved row already
    // exists (status = 'stopped') — flip it back to running. On the slow
    // path (no preserved row) insert fresh.
    const activeReplica = preserved ?? db.insertReplica({
      app_id: appId,
      server_id: serverId,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "attesting" : "unhealthy",
    });
    if (preserved) {
      if (health.healthy) {
        db.updateReplicaStatus(preserved.id, "attesting");
      } else {
        db.updateReplicaStatus(preserved.id, "unhealthy");
      }
    }
    if (health.healthy) {
      const attestation = await attestReplica(app, activeReplica, server, {
        imageDigest: desiredImage,
        envHash: desiredEnvHash,
        configRevision: app.config_revision,
      });
      if (!attestation.ok) throw new Error(`Woken replica attestation failed: ${attestation.error}`);
      db.markReplicaRunning(activeReplica.id);
    } else {
      throw new Error("Woken replica did not become healthy");
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
