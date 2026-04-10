import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { resolveGitHubToken } from "../github-token.ts";
import { type ProgressFn, log } from "./types.ts";

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

    const lbId = app.hetzner_lb_id;
    if (!lbId) throw new Error("No load balancer found for rolling deploy");

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
        await hetzner.transferImage(
          primaryServer.ipv4,
          server.ipv4,
          imageName,
          primaryServer.ssh_host_key || undefined,
          hostKey
        );
      }

      // Remove from LB
      try {
        await hetzner.removeLBTarget(lbId, server.hetzner_id);
      } catch {}

      // Drain
      emit("scale", `Draining ${replica.container_name}...`);
      await Bun.sleep(10_000);

      // Recreate container
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      if (app.deploy_mode === "compose") {
        await hetzner.cloneAndComposeBuild(
          server.ipv4,
          {
            name: app.name,
            gitRepo: app.git_repo,
            port: app.container_port,
            hostPort: replica.host_port,
            envVars: JSON.parse(app.env_vars || "{}"),
            volumeMount: app.volume_mount || undefined,
            composeFile: app.compose_file,
            webService: app.compose_web_service,
            gitToken: githubPat,
          },
          (line) => emit("scale", line)
        );
      } else {
        await hetzner.sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
        const envVars = JSON.parse(app.env_vars || "{}");
        const envEntries = Object.entries(envVars);
        let envFileFlag = "";
        if (envEntries.length > 0) {
          const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
          envFileFlag = `--env-file ${envFilePath}`;
        }
        const cmd = `docker run -d --name ${replica.container_name} --restart unless-stopped -p 0.0.0.0:${replica.host_port}:${app.container_port} ${envFileFlag} ${imageName}`;
        await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
      }

      // Health check
      const health = app.deploy_mode === "compose"
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, replica.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, replica.container_name, replica.host_port, 5, hostKey);

      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

      // Add back to LB
      await hetzner.addLBTarget(lbId, server.hetzner_id);

      emit("scale", `Replica ${replica.container_name} updated`);
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("rolling", `Rolling redeploy failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
