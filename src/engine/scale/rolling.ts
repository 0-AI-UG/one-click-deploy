import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  transferImage, probeAppHealth, startAppReplica,
} from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { type ProgressFn, log, replicaBindHost, appReplicaRunOpts } from "./types.ts";
import { attestReplica } from "../revision.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { resolveArtifactRegistry } from "../registry-config.ts";

export async function rollingRedeploy(
  appId: number,
  onProgress?: ProgressFn,
  expectedRevision?: { imageDigest: string; envHash: string; configRevision: number },
  candidate?: { app: AppRow; envVars: Record<string, string> },
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});

  try {
    const storedApp = db.getApp(appId);
    if (!storedApp) throw new Error("App not found");
    const app = candidate?.app ?? storedApp;

    const replicas = db.getReplicas(appId);
    if (replicas.length <= 1) {
      return { ok: true }; // Single replica handled by normal redeploy
    }

    // Use the first replica's server as the image source for transferImage.
    const primaryServer = db.getServer(replicas[0].server_id);
    if (!primaryServer) throw new Error("First replica's server not found");

    const imageName = expectedRevision?.imageDigest || `${app.name}:latest`;
    const registryToken = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
    const distribution = await resolveArtifactRegistry(app.build_cache_ref);

    for (let i = 0; i < replicas.length; i++) {
      const replica = replicas[i];
      const server = db.getServer(replica.server_id);
      if (!server) continue;

      const hostKey = server.ssh_host_key || undefined;
      emit("scale", `Rolling update ${i + 1}/${replicas.length}: ${replica.container_name}...`);

      // Transfer new image
      if (server.id !== primaryServer.id) {
        await transferImage(
          primaryServer.ipv4,
          server.ipv4,
          imageName,
          primaryServer.ssh_host_key || undefined,
          hostKey,
          {
            registryRef: distribution.ref,
            registryUsername: distribution.username,
            registryPassword: distribution.password,
            registryToken,
            allowArchiveFallback: db.getSettings().allow_archive_image_transfer === "1",
            onProgress: (line) => emit("transfer", line),
            onStorage: (storage) => {
              const deployment = db.getLastSuccessfulDeployment(app.id);
              if (deployment) db.updateDeploymentStorage(deployment.id, {
                image_size_bytes: storage.imageBytes,
                archive_size_bytes: storage.archiveBytes,
                transfer_size_bytes: storage.transferBytes,
              });
            },
          },
        );
      }

      // Drop from the ingress upstream pool so in-flight requests drain
      // via the other replicas before we tear this one down.
      db.updateReplicaStatus(replica.id, "draining");
      try {
        await syncAppIngress(app.id);
      } catch (err) {
        log("scale", `Ingress sync during rolling drain failed: ${err}`);
      }

      // Drain
      emit("scale", `Draining ${replica.container_name}...`);
      await Bun.sleep(10_000);

      // Recreate container. Bind on the target server's private IPv4 so only
      // the ingress proxy (also on the private network) can reach this replica.
      const replicaBindAddr = replicaBindHost(server);

      // Rewrite the projected environment on every target. Reusing an
      // existing .env.deploy file here is what allowed replicas on different
      // servers to retain different revisions.
      const envVars = candidate?.envVars ?? await resolveAppEnvVars(app);
      await startAppReplica(server.ipv4, {
        ...appReplicaRunOpts(app, server, { containerName: replica.container_name, hostPort: replica.host_port, envVars }),
        image: imageName,
        configRevision: expectedRevision?.configRevision ?? app.config_revision,
        envHash: expectedRevision?.envHash,
      }, hostKey);

      // Health check (running-only when the app opted out of the HTTP probe)
      const health = await probeAppHealth(app, server.ipv4, replica.container_name, replicaBindAddr, replica.host_port, 5, hostKey);

      if (!health.healthy) {
        db.updateReplicaStatus(replica.id, "unhealthy");
        throw new Error(`Replica ${replica.id} failed health verification`);
      }
      db.updateReplicaStatus(replica.id, "attesting");
      if (expectedRevision) {
        const attestation = await attestReplica(app, replica, server, expectedRevision);
        if (!attestation.ok) throw new Error(`Replica ${replica.id} attestation failed: ${attestation.error}`);
      }
      db.updateReplicaStatus(replica.id, "running");

      // Re-admit this replica to the ingress upstream pool.
      try {
        await syncAppIngress(app.id);
      } catch (err) {
        log("scale", `Ingress sync after rolling replace failed: ${err}`);
      }

      emit("scale", `Replica ${replica.container_name} updated`);
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("rolling", `Rolling redeploy failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
