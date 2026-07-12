import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  transferImage, probeAppHealth, startAppReplica,
} from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { type ProgressFn, log, replicaBindHost } from "./types.ts";

export async function rollingRedeploy(
  appId: number,
  onProgress?: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});

  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const replicas = db.getReplicas(appId);
    if (replicas.length <= 1) {
      return { ok: true }; // Single replica handled by normal redeploy
    }

    // Use the first replica's server as the image source for transferImage.
    const primaryServer = db.getServer(replicas[0].server_id);
    if (!primaryServer) throw new Error("First replica's server not found");

    const imageName = `${app.name}:latest`;

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
          hostKey
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

      const envVars = await resolveAppEnvVars(app);
      const envFilePath = Object.keys(envVars).length > 0
        ? `/home/deploy/apps/${app.name}/.env.deploy`
        : undefined;
      await startAppReplica(server.ipv4, {
        containerName: replica.container_name,
        image: imageName,
        appName: app.name,
        network: null,
        bindAddr: replicaBindAddr,
        hostPort: replica.host_port,
        containerPort: app.container_port,
        envFilePath,
        volumeMount: app.volume_mount || undefined,
        extraVolumes: db.parseExtraVolumes(app.extra_volumes),
        memoryMb: app.memory_mb || undefined,
      }, hostKey);

      // Health check (running-only when the app opted out of the HTTP probe)
      const health = await probeAppHealth(app, server.ipv4, replica.container_name, replicaBindAddr, replica.host_port, 5, hostKey);

      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

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
