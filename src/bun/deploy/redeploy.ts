import type { ServerWithApps } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { validateEnvVars } from "../validate.ts";
import { getTokens } from "../secret-store.ts";
import { rollingRedeploy } from "../scale.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function redeployApp(
  appId: number,
  onProgress: ProgressFn,
  newEnvVars?: Record<string, string>,
  newAuthPassword?: string | null
): Promise<{ ok: boolean; error?: string }> {
  log("redeployApp", `Redeploying app id=${appId}`);
  let previousStatus = "running"; // fallback if app lookup fails
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    // Capture previous state for rollback
    previousStatus = app.status;

    // Defer DB writes — hold new values in local vars, only persist after success
    const authPassword = newAuthPassword !== undefined ? (newAuthPassword || "") : app.auth_password;

    const envVars = newEnvVars ?? JSON.parse(app.env_vars || "{}");
    const hostKey = server.ssh_host_key || undefined;

    const tokens = await getTokens();
    const githubPat = tokens.github_pat || undefined;

    // Self-redeploy: if we're being asked to redeploy the very container
    // we're running in, doing it inline would `docker rm -f` ourselves
    // mid-rebuild and the new container would never be started. Dispatch
    // the rebuild as a detached host process via SSH and return immediately.
    // (Webhook redeploys already work because the webhook receiver runs as
    // a separate systemd service on the host.)
    // Docker sets $HOSTNAME inside the container to the short container ID
    // (NOT the --name). To know whether `app` is *us*, ask the host to
    // resolve our container ID to a container name and compare.
    const ourContainerId = process.env.HOSTNAME || "";
    let isSelf = false;
    if (ourContainerId) {
      try {
        const inspect = await hetzner.sshExec(
          server.ipv4,
          `docker inspect --format '{{.Id}}' ${app.name} 2>/dev/null || true`,
          hostKey,
        );
        const fullId = inspect.stdout.trim();
        if (fullId && fullId.startsWith(ourContainerId)) isSelf = true;
      } catch {
        // best effort
      }
    }
    if (isSelf) {
      log("redeployApp", `Self-redeploy detected for "${app.name}" (container=${ourContainerId}) — dispatching out-of-band`);
      onProgress("build", "Self-redeploy: dispatching detached host rebuild...");
      db.updateAppStatus(appId, "deploying");

      // If the caller passed new env vars, write the new .env.deploy on the
      // host before triggering the rebuild so it picks them up.
      const appDir = `/home/deploy/apps/${app.name}`;
      const envFilePath = `${appDir}/.env.deploy`;
      if (newEnvVars) {
        const envFileContent = Object.entries(newEnvVars).map(([k, v]) => `${k}=${v}`).join("\n");
        const escaped = envFileContent.replace(/'/g, "'\\''");
        await hetzner.sshExec(
          server.ipv4,
          `echo '${escaped}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
          hostKey,
        );
        db.updateAppEnvVars(appId, JSON.stringify(newEnvVars));
      }

      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const rebuildScript = [
        `set -e`,
        `cd ${appDir}`,
        `su - deploy -c "cd ${appDir} && git pull"`,
        `su - deploy -c "cd ${appDir} && docker build -t ${app.name}:latest ."`,
        `docker rm -f ${app.name} 2>/dev/null || true`,
        `su - deploy -c "docker run -d --name ${app.name} --restart unless-stopped -p 127.0.0.1:${app.host_port}:${app.container_port} --env-file ${envFilePath} ${volumeFlag} ${app.name}:latest"`,
      ].join("\n");

      // Write the script to /tmp and launch it detached so it survives
      // both the SSH session ending and the panel container being killed.
      const dispatch = [
        `cat > /tmp/ocd-self-redeploy.sh <<'OCD_EOF'`,
        rebuildScript,
        `OCD_EOF`,
        `chmod +x /tmp/ocd-self-redeploy.sh`,
        `setsid bash -c '/tmp/ocd-self-redeploy.sh > /tmp/ocd-self-redeploy.log 2>&1 < /dev/null' &`,
        `disown || true`,
        `echo dispatched`,
      ].join("\n");

      const result = await hetzner.sshExec(server.ipv4, dispatch, hostKey);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to dispatch self-redeploy: ${result.stderr}`);
      }

      db.appendDeployLog(appId, `[redeploy] Self-redeploy dispatched out-of-band; panel will restart shortly`);
      db.insertDeployment({
        app_id: appId,
        image_tag: `${app.name}:latest`,
        git_commit: "self-redeploy",
        source: "self-redeploy",
      });
      // Optimistically flip status back to "running". Nothing else will
      // ever correct it: the reconciler only updates replica rows, and
      // self-deployed panels have no replica row (the snapshot is taken
      // before insertReplica runs in deploy.ts).
      db.updateAppStatus(appId, "running");
      onProgress("done", "Self-redeploy dispatched; panel will restart shortly");
      return { ok: true };
    }

    db.updateAppStatus(appId, "deploying");
    onProgress("build", "Pulling latest code and rebuilding...");

    // Build new image on primary server first
    let buildImageTag = `${app.name}:latest`;
    if (app.deploy_mode === "compose") {
      await hetzner.cloneAndComposeBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort: app.host_port,
          envVars,
          volumeMount: app.volume_mount || undefined,
          composeFile: app.compose_file,
          webService: app.compose_web_service,
          gitToken: githubPat,
        },
        (line) => {
          db.appendDeployLog(appId, `[redeploy] ${line}`);
          onProgress("build", line);
        }
      );
    } else {
      const buildResult = await hetzner.cloneAndBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort: app.host_port,
          envVars,
          volumeMount: app.volume_mount || undefined,
          dockerfilePath: app.dockerfile_path || undefined,
          gitToken: githubPat,
        },
        (line) => {
          db.appendDeployLog(appId, `[redeploy] ${line}`);
          onProgress("build", line);
        }
      );
      if (buildResult.imageTag) {
        buildImageTag = buildResult.imageTag;
      }
    }

    // If scaled (>1 replicas), do rolling deploy for the other replicas
    const replicas = db.getReplicas(appId);
    if (replicas.length > 1 && app.hetzner_lb_id) {
      onProgress("scale", "Starting rolling update across replicas...");
      const rollingResult = await rollingRedeploy(appId, onProgress);
      if (!rollingResult.ok) {
        db.appendDeployLog(appId, `[redeploy] Rolling update warning: ${rollingResult.error}`);
      }
    }

    // Handle auth proxy: deploy, update, or remove (primary server)
    let caddyPort = app.host_port;
    if (authPassword) {
      caddyPort = await hetzner.deployAuthProxy(server.ipv4, app.name, authPassword, app.host_port, hostKey);
    } else if (app.auth_password && !authPassword) {
      await hetzner.removeAuthProxy(server.ipv4, app.name, hostKey);
    }

    // Only update Caddy if single-replica (LB handles TLS when scaled)
    if (!app.hetzner_lb_id) {
      onProgress("caddy", "Reloading reverse proxy...");
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      await hetzner.deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls, hostKey);
    }

    onProgress("health", "Checking app health...");
    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
      : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Success — now persist env/auth changes to DB
    if (newEnvVars) {
      db.updateAppEnvVars(appId, JSON.stringify(newEnvVars));
    }
    if (newAuthPassword !== undefined) {
      db.updateAppAuthPassword(appId, newAuthPassword || "");
    }

    // Record deployment
    const gitCommitResult = await hetzner.sshExec(
      server.ipv4,
      `su - deploy -c "cd /home/deploy/apps/${app.name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
      hostKey
    );
    db.insertDeployment({
      app_id: appId,
      image_tag: buildImageTag,
      git_commit: gitCommitResult.stdout.trim(),
    });

    db.appendDeployLog(appId, `[done] Redeployed successfully`);
    onProgress("done", "Redeployed successfully");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("redeployApp", `Failed:`, msg);
    // Rollback: restore previous status (env/auth were never written to DB)
    db.updateAppStatus(appId, previousStatus);
    return { ok: false, error: msg };
  }
}

export async function updateAppEnv(
  appId: number,
  envVars: Record<string, string>
): Promise<{ ok: boolean; error?: string }> {
  log("updateAppEnv", `Updating env vars for app id=${appId}`);
  try {
    const envResult = validateEnvVars(envVars);
    if (!envResult.valid) return { ok: false, error: envResult.error };

    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    // Defer DB write — only persist after successful rebuild
    // Recreate container with new env vars
    const hostKey = server.ssh_host_key || undefined;
    const tokens = await getTokens();
    const githubPat = tokens.github_pat || undefined;
    const logLine = (line: string) => db.appendDeployLog(appId, `[env-update] ${line}`);

    if (app.deploy_mode === "compose") {
      await hetzner.cloneAndComposeBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort: app.host_port,
          envVars,
          volumeMount: app.volume_mount || undefined,
          composeFile: app.compose_file,
          webService: app.compose_web_service,
          gitToken: githubPat,
        },
        logLine
      );
    } else {
      // No explicit removeContainer — cloneAndBuild handles build-before-destroy internally
      await hetzner.cloneAndBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort: app.host_port,
          envVars,
          volumeMount: app.volume_mount || undefined,
          dockerfilePath: app.dockerfile_path || undefined,
          gitToken: githubPat,
        },
        logLine
      );
    }

    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
      : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Success — now persist env vars to DB
    db.updateAppEnvVars(appId, JSON.stringify(envVars));

    log("updateAppEnv", `Env vars updated for app id=${appId}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("updateAppEnv", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function rollbackApp(
  appId: number,
  deploymentId: number
): Promise<{ ok: boolean; error?: string }> {
  log("rollbackApp", `Rolling back app id=${appId} to deployment id=${deploymentId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");
    const deployment = db.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.app_id !== appId) throw new Error("Deployment does not belong to this app");

    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const appDir = `/home/deploy/apps/${app.name}`;

    if (app.deploy_mode === "compose") {
      // Compose rollback: checkout old commit and rebuild
      await hetzner.sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${deployment.git_commit}`), hostKey);

      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      if (envEntries.length > 0) {
        const envFilePath = `${appDir}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await hetzner.sshExec(server.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, hostKey);
      }

      const envFileFlag = envEntries.length > 0 ? `--env-file ${appDir}/.env.deploy` : "";
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d --build`;
      const result = await hetzner.sshExec(server.ipv4, asUser(composeCmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to rollback compose project — the previous version may have build errors");
      }
    } else {
      // Dockerfile rollback: restart with old image tag
      await hetzner.removeContainer(server.ipv4, app.name, hostKey);

      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envEntries.length > 0) {
        const envFilePath = `${appDir}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await hetzner.sshExec(server.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, hostKey);
        envFileFlag = `--env-file ${envFilePath}`;
      }

      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p 127.0.0.1:${app.host_port}:${app.container_port} ${envFileFlag} ${volumeFlag} ${deployment.image_tag}`;
      const result = await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to rollback — the previous image may no longer be available on this server");
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, app.host_port, 5, hostKey)
      : await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Record rollback as new deployment
    db.insertDeployment({
      app_id: appId,
      image_tag: deployment.image_tag,
      git_commit: `rollback-from-${deployment.git_commit}`,
    });

    db.appendDeployLog(appId, `[rollback] Rolled back to deployment ${deploymentId} (${deployment.image_tag})`);
    log("rollbackApp", `Rollback complete for app id=${appId}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("rollbackApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export function getServersWithApps(): ServerWithApps[] {
  const servers = db.getServers();
  return servers.map((s) => ({
    ...s,
    apps: db.getApps(s.id),
  }));
}
