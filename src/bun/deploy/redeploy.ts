import type { ServerWithApps, Server } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import { getComputeProvider } from "../providers/index.ts";
import {
  sshExec, cloneAndBuild, cloneAndComposeBuild, cloneAndRailpackBuild,
  deployCaddySite, deployAuthProxy, removeAuthProxy, removeContainer,
  healthCheck, composeHealthCheck,
} from "../remote/index.ts";
import { validateEnvVars } from "../validate.ts";
import { resolveGitHubToken } from "../github-token.ts";
import { rollingRedeploy } from "../scale.ts";

type DbApp = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_mode: string;
  compose_file: string;
  compose_web_service: string;
  dockerfile_path: string;
  lb_provider_id: string;
  volume_id: string;
  volume_mount: string;
  auth_password: string;
  webhook_enabled: number;
  github_webhook_id: string;
  deployed_by: string | null;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  created_at: string;
};

type DbReplica = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
};

type DbService = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
};

type DbServiceLink = {
  app_id: number;
  app_name: string;
};

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function redeployApp(
  appId: number,
  onProgress: ProgressFn,
  newEnvVars?: Record<string, string>,
  newAuthPassword?: string | null,
  newContainerPort?: number,
  userId?: string,
): Promise<{ ok: boolean; error?: string }> {
  log("redeployApp", `Redeploying app id=${appId}`);
  let previousStatus = "running"; // fallback if app lookup fails
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const replicasInit = db.getReplicas(appId);
    if (replicasInit.length === 0) throw new Error("App has no replicas");
    const firstReplica = replicasInit[0];
    const server = db.getServer(firstReplica.server_id);
    if (!server) throw new Error("Server not found");
    const hostPort = firstReplica.host_port;

    // Capture previous state for rollback
    previousStatus = app.status;

    // Defer DB writes — hold new values in local vars, only persist after success
    const authPassword = newAuthPassword !== undefined ? (newAuthPassword || "") : app.auth_password;

    const envVars = newEnvVars ?? JSON.parse(app.env_vars || "{}");
    const containerPort = newContainerPort ?? app.container_port;
    const hostKey = server.ssh_host_key || undefined;

    const resolvedGitToken = await resolveGitHubToken(userId);
    const githubPat = resolvedGitToken || undefined;

    if (userId) db.updateAppDeployedBy(appId, userId);
    db.updateAppStatus(appId, "deploying");
    onProgress("build", "Pulling latest code and rebuilding...");

    // Build new image on primary server first
    let buildImageTag = `${app.name}:latest`;
    if (app.deploy_mode === "compose") {
      await cloneAndComposeBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
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
    } else if (app.deploy_mode === "railpack") {
      const buildResult = await cloneAndRailpackBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
          envVars,
          volumeMount: app.volume_mount || undefined,
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
    } else {
      const buildResult = await cloneAndBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
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
    if (replicas.length > 1 && app.lb_provider_id) {
      onProgress("scale", "Starting rolling update across replicas...");
      const rollingResult = await rollingRedeploy(appId, onProgress);
      if (!rollingResult.ok) {
        db.appendDeployLog(appId, `[redeploy] Rolling update warning: ${rollingResult.error}`);
      }
    }

    // Handle auth proxy: deploy, update, or remove (primary server)
    let caddyPort = hostPort;
    if (authPassword) {
      caddyPort = await deployAuthProxy(server.ipv4, app.name, authPassword, hostPort, hostKey);
    } else if (app.auth_password && !authPassword) {
      await removeAuthProxy(server.ipv4, app.name, hostKey);
    }

    // Only update Caddy if single-replica (LB handles TLS when scaled)
    if (!app.lb_provider_id) {
      onProgress("caddy", "Reloading reverse proxy...");
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      await deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls, hostKey);
    }

    onProgress("health", "Checking app health...");
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, app.name, hostPort, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Success — now persist env/auth changes to DB
    if (newEnvVars) {
      db.updateAppEnvVars(appId, JSON.stringify(newEnvVars));
    }
    if (newAuthPassword !== undefined) {
      db.updateAppAuthPassword(appId, newAuthPassword || "");
    }
    if (newContainerPort !== undefined && newContainerPort !== app.container_port) {
      db.updateAppContainerPort(appId, newContainerPort);
    }

    // Record deployment
    const gitCommitResult = await sshExec(
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
  envVars: Record<string, string>,
  userId?: string,
): Promise<{ ok: boolean; error?: string }> {
  log("updateAppEnv", `Updating env vars for app id=${appId}`);
  try {
    const envResult = validateEnvVars(envVars);
    if (!envResult.valid) return { ok: false, error: envResult.error };

    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const firstReplica = replicas[0];
    const server = db.getServer(firstReplica.server_id);
    if (!server) throw new Error("Server not found");
    const hostPort = firstReplica.host_port;
    const containerPort = app.container_port;

    // Defer DB write — only persist after successful rebuild
    // Recreate container with new env vars
    const hostKey = server.ssh_host_key || undefined;
    const resolvedGitToken = await resolveGitHubToken(userId);
    const githubPat = resolvedGitToken || undefined;
    const logLine = (line: string) => db.appendDeployLog(appId, `[env-update] ${line}`);

    if (app.deploy_mode === "compose") {
      await cloneAndComposeBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
          envVars,
          volumeMount: app.volume_mount || undefined,
          composeFile: app.compose_file,
          webService: app.compose_web_service,
          gitToken: githubPat,
        },
        logLine
      );
    } else if (app.deploy_mode === "railpack") {
      await cloneAndRailpackBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
          envVars,
          volumeMount: app.volume_mount || undefined,
          gitToken: githubPat,
        },
        logLine
      );
    } else {
      await cloneAndBuild(
        server.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: containerPort,
          hostPort: hostPort,
          envVars,
          volumeMount: app.volume_mount || undefined,
          dockerfilePath: app.dockerfile_path || undefined,
          gitToken: githubPat,
        },
        logLine
      );
    }

    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, app.name, hostPort, 5, hostKey);
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
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const firstReplica = replicas[0];
    const server = db.getServer(firstReplica.server_id);
    if (!server) throw new Error("Server not found");
    const hostPort = firstReplica.host_port;
    const deployment = db.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.app_id !== appId) throw new Error("Deployment does not belong to this app");

    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const appDir = `/home/deploy/apps/${app.name}`;

    if (app.deploy_mode === "compose") {
      // Compose rollback: checkout old commit and rebuild
      await sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${deployment.git_commit}`), hostKey);

      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      if (envEntries.length > 0) {
        const envFilePath = `${appDir}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await sshExec(server.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, hostKey);
      }

      const envFileFlag = envEntries.length > 0 ? `--env-file ${appDir}/.env.deploy` : "";
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d --build`;
      const result = await sshExec(server.ipv4, asUser(composeCmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to rollback compose project — the previous version may have build errors");
      }
    } else {
      // Dockerfile rollback: restart with old image tag
      await removeContainer(server.ipv4, app.name, hostKey);

      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envEntries.length > 0) {
        const envFilePath = `${appDir}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await sshExec(server.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, hostKey);
        envFileFlag = `--env-file ${envFilePath}`;
      }

      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p 127.0.0.1:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${deployment.image_tag}`;
      const result = await sshExec(server.ipv4, asUser(cmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to rollback — the previous image may no longer be available on this server");
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, app.name, hostPort, 5, hostKey);
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

// ── Webhook-triggered rolling redeploy ──
//
// In-process per-app queue: pushes for the same app are serialized;
// pushes for different apps run in parallel. Single-instance panel only.
const webhookQueues = new Map<number, Promise<void>>();

export function enqueueWebhookRedeploy(
  appId: number,
  gitSha: string,
  runner: (appId: number, gitSha: string) => Promise<void> = webhookRedeployApp,
): Promise<void> {
  const prev = webhookQueues.get(appId) ?? Promise.resolve();
  // Swallow the previous job's error so the queue keeps running regardless of prior failures.
  const next = prev.catch(() => {}).then(() => runner(appId, gitSha));
  webhookQueues.set(
    appId,
    next.finally(() => {
      if (webhookQueues.get(appId) === next) webhookQueues.delete(appId);
    }),
  );
  return next;
}

// exported for tests
export function _resetWebhookQueues() {
  webhookQueues.clear();
}

export async function webhookRedeployApp(appId: number, gitSha: string): Promise<void> {
  const app = db.getApp(appId);
  if (!app) {
    log("webhookRedeploy", `App ${appId} not found`);
    return;
  }
  const replicas = db.getReplicas(appId);
  if (replicas.length === 0) {
    log("webhookRedeploy", `App ${appId} has no replicas`);
    return;
  }

  const dep = db.insertDeployment({
    app_id: appId,
    image_tag: `${app.name}:latest`,
    git_commit: gitSha || "unknown",
    status: "in_progress",
    source: "webhook",
    deploy_log: "",
  });
  const depId = dep.id;
  const append = (line: string) => db.appendDeploymentLog(depId, line);

  // Use the token of the user who deployed this app
  const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
  const lbId = app.lb_provider_id;
  const multi = replicas.length > 1 && !!lbId;

  append(`[webhook] Starting rolling redeploy across ${replicas.length} replica(s)`);

  try {
    db.updateAppStatus(appId, "deploying");

    for (let i = 0; i < replicas.length; i++) {
      const replica = replicas[i];
      const server = db.getServer(replica.server_id);
      if (!server) {
        throw new Error(`Replica ${replica.id} server not found`);
      }
      const hostKey = server.ssh_host_key || undefined;
      append(`[webhook] (${i + 1}/${replicas.length}) ${replica.container_name} on ${server.name}`);

      if (multi) {
        try {
          const compute = getComputeProvider();
          await compute.loadBalancers!.removeTarget(lbId!, server.provider_id);
        } catch (e) {
          append(`[webhook] Warning: failed to remove LB target for ${replica.container_name}: ${e}`);
        }
        append(`[webhook] Drained ${replica.container_name}, waiting 10s`);
        await Bun.sleep(10_000);
      }

      if (app.deploy_mode === "compose") {
        await cloneAndComposeBuild(
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
          (line) => append(`[build] ${line}`),
        );
      } else if (app.deploy_mode === "railpack") {
        await cloneAndRailpackBuild(
          server.ipv4,
          {
            name: app.name,
            gitRepo: app.git_repo,
            port: app.container_port,
            hostPort: replica.host_port,
            envVars: JSON.parse(app.env_vars || "{}"),
            volumeMount: app.volume_mount || undefined,
            gitToken: githubPat,
          },
          (line) => append(`[build] ${line}`),
        );
        if (multi) {
          const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
          await sshExec(
            server.ipv4,
            asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`),
            hostKey,
          );
          const envVars = JSON.parse(app.env_vars || "{}");
          let envFileFlag = "";
          if (Object.keys(envVars).length > 0) {
            envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
          }
          const cmd = `docker run -d --name ${replica.container_name} --restart unless-stopped -p 0.0.0.0:${replica.host_port}:${app.container_port} ${envFileFlag} ${app.name}:latest`;
          await sshExec(server.ipv4, asUser(cmd), hostKey);
        }
      } else {
        await cloneAndBuild(
          server.ipv4,
          {
            name: app.name,
            gitRepo: app.git_repo,
            port: app.container_port,
            hostPort: replica.host_port,
            envVars: JSON.parse(app.env_vars || "{}"),
            volumeMount: app.volume_mount || undefined,
            dockerfilePath: app.dockerfile_path || undefined,
            gitToken: githubPat,
          },
          (line) => append(`[build] ${line}`),
        );
        if (multi) {
          // Multi-replica: rebind to 0.0.0.0 so the LB can reach it.
          const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
          await sshExec(
            server.ipv4,
            asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`),
            hostKey,
          );
          const envVars = JSON.parse(app.env_vars || "{}");
          let envFileFlag = "";
          if (Object.keys(envVars).length > 0) {
            envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
          }
          const cmd = `docker run -d --name ${replica.container_name} --restart unless-stopped -p 0.0.0.0:${replica.host_port}:${app.container_port} ${envFileFlag} ${app.name}:latest`;
          await sshExec(server.ipv4, asUser(cmd), hostKey);
        }
      }

      const health = app.deploy_mode === "compose"
        ? await composeHealthCheck(server.ipv4, app.name, replica.host_port, 5, hostKey)
        : await healthCheck(server.ipv4, replica.container_name, replica.host_port, 5, hostKey);

      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

      if (!health.healthy) {
        throw new Error(`Replica ${replica.container_name} failed health check after rebuild`);
      }

      if (multi) {
        const compute = getComputeProvider();
        await compute.loadBalancers!.addTarget(lbId!, server.provider_id);
        append(`[webhook] Re-added ${replica.container_name} to LB`);
      }

      // Capture commit hash from this replica (first one wins).
      if (i === 0) {
        try {
          const r = await sshExec(
            server.ipv4,
            `su - deploy -c "cd /home/deploy/apps/${app.name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
            hostKey,
          );
          const sha = r.stdout.trim();
          if (sha && sha !== "unknown") db.updateDeploymentGitCommit(depId, sha);
        } catch (e) {
          append(`[webhook] Warning: failed to capture git commit hash: ${e}`);
        }
      }
    }

    append(`[webhook] Rolling redeploy complete`);
    db.updateDeploymentStatus(depId, "deployed");
    db.updateAppStatus(appId, "running");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    append(`[webhook] FAILED: ${msg}`);
    log("webhookRedeploy", `App ${appId} failed:`, msg);
    db.updateDeploymentStatus(depId, "failed");
    db.updateAppStatus(appId, "unhealthy");
  }
}

export function getServersWithApps(): any[] {
  const servers = db.getServers() as Server[];
  const allAppsGlobal = db.getApps() as DbApp[];
  return servers.map((s) => {
    const activeApps = db.getApps(s.id) as DbApp[];
    // Include sleeping apps (scale-to-zero) associated with this server
    const sleepingApps = allAppsGlobal.filter(
      (a: DbApp) => a.sleeping_server_id === s.id && !activeApps.some((aa: DbApp) => aa.id === a.id)
    );
    const allApps = [...activeApps, ...sleepingApps];
    return {
    ...s,
    apps: allApps.map((a: DbApp) => {
      const reps = db.getReplicas(a.id) as DbReplica[];
      const first = reps[0];
      const serverIds = Array.from(new Set(reps.map((r: DbReplica) => r.server_id)));
      const deployedByUser = a.deployed_by ? db.getUserById(a.deployed_by) : null;
      return {
        ...a,
        host_port: first?.host_port ?? a.sleeping_host_port ?? 0,
        servers: serverIds,
        deployed_by_username: deployedByUser?.username || null,
      };
    }),
    services: (db.getServicesOnServer(s.id) as DbService[]).map((svc: DbService) => {
      const instances = db.getServiceInstances(svc.id);
      const links = db.getServiceLinks(svc.id) as DbServiceLink[];
      return {
        ...svc,
        instance_count: instances.length,
        linked_apps: links.map((l: DbServiceLink) => ({ id: l.app_id, name: l.app_name })),
      };
    }),
  };
  });
}
