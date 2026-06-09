import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, cloneAndComposeBuild, transferImage, healthCheck, composeHealthCheck,
  buildDockerRunArgs,
} from "../../shared/remote/index.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { syncAppCaddy } from "./caddy-manager.ts";
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
    const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;

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

      // Drop from the Caddy upstream list so in-flight requests drain
      // via the other replicas before we tear this one down.
      db.updateReplicaStatus(replica.id, "draining");
      try {
        await syncAppCaddy(app.id);
      } catch (err) {
        log("scale", `Caddy sync during rolling drain failed: ${err}`);
      }

      // Drain
      emit("scale", `Draining ${replica.container_name}...`);
      await Bun.sleep(10_000);

      // Recreate container
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      // Bind on the target server's private IPv4 so only the panel
      // Caddy (also on the private network) can reach this replica.
      const replicaBindAddr = replicaBindHost(server);

      let rollingExtraVols: string[] = [];
      try { const ev = JSON.parse(app.extra_volumes); if (Array.isArray(ev)) rollingExtraVols = ev; } catch {}
      if (app.deploy_mode === "compose") {
        await cloneAndComposeBuild(
          server.ipv4,
          {
            name: app.name,
            gitRepo: app.git_repo,
            port: app.container_port,
            hostPort: replica.host_port,
            envVars: await resolveAppEnvVars(app),
            volumeMount: app.volume_mount || undefined,
            extraVolumes: rollingExtraVols,
            composeFile: app.compose_file,
            webService: app.compose_web_service,
            gitToken: githubPat,
            gitBranch: app.git_branch || undefined,
            bindAddr: replicaBindAddr,
          },
          (line) => emit("scale", line)
        );
      } else {
        await sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
        const envVars = await resolveAppEnvVars(app);
        const envFilePath = Object.keys(envVars).length > 0
          ? `/home/deploy/apps/${app.name}/.env.deploy`
          : undefined;
        const cmd = buildDockerRunArgs({
          name: replica.container_name,
          image: imageName,
          appName: app.name,
          network: null,
          publish: { bindAddr: replicaBindAddr, hostPort: replica.host_port, containerPort: app.container_port },
          envFilePath,
          volumeMount: app.volume_mount || undefined,
          extraVolumes: rollingExtraVols,
          memoryMb: app.memory_mb || undefined,
          userns: app.userns ? true : undefined,
        });
        await sshExec(server.ipv4, asUser(cmd), hostKey);
      }

      // Health check
      const health = app.deploy_mode === "compose"
        ? await composeHealthCheck(server.ipv4, app.name, replicaBindAddr, replica.host_port, 5, hostKey)
        : await healthCheck(server.ipv4, replica.container_name, replicaBindAddr, replica.host_port, 5, hostKey);

      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

      // Re-install this replica in the panel Caddy upstream list.
      try {
        await syncAppCaddy(app.id);
      } catch (err) {
        log("scale", `Caddy sync after rolling replace failed: ${err}`);
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
