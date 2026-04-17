import * as db from "../../shared/db.ts";
import {
  sshExec,
  cloneAndBuild,
  cloneAndComposeBuild,
  cloneAndRailpackBuild,
  deployAuthProxy,
  removeAuthProxy,
  removeContainer,
  removeCompose,
  healthCheck,
  composeHealthCheck,
} from "../../shared/remote/index.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { rollingRedeploy } from "../scale-api.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppCaddy } from "../scale/caddy-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RedeployInput = {
  appId: number;
  auth_password?: string | null;
  container_port?: number;
  userId?: string;
};

type WakeOut = { woke: boolean };
type BuildOut = {
  imageTag: string;
  deployMode: "dockerfile" | "compose" | "railpack";
  previousStatus: string;
  previousAuthPassword: string;
  previousContainerPort: number;
};
type SwapOut = { containerName: string; oldImageTag: string };
type HealthOut = { healthy: boolean; statusCode?: number };

function parseExtraVolumes(raw: string): string[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const wakeIfSleeping: Step<RedeployInput, WakeOut> = {
  name: "wake_if_sleeping",
  label: "Wake app",
  async run(ctx) {
    const app = db.getAppUnscoped(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (app.status !== "sleeping") return { woke: false };
    const result = await wakeApp(ctx.input.appId);
    if (!result.ok) throw new Error(`Failed to wake sleeping app: ${result.error}`);
    return { woke: true };
  },
};

const pullAndBuild: Step<RedeployInput, BuildOut> = {
  name: "pull_and_build",
  label: "Pull and build",
  async run(ctx) {
    const { appId } = ctx.input;
    const app = db.getAppUnscoped(appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const server = db.getServerUnscoped(first.server_id);
    if (!server) throw new Error("Server not found");

    const previousStatus = app.status;
    const previousAuthPassword = app.auth_password;
    const previousContainerPort = app.container_port;

    const authPassword = ctx.input.auth_password !== undefined
      ? (ctx.input.auth_password || "")
      : app.auth_password;
    const containerPort = ctx.input.container_port ?? app.container_port;
    const envVars = await resolveAppEnvVars(app);
    const hostKey = server.ssh_host_key || undefined;
    const githubPat = (await resolveGitHubToken(ctx.input.userId)) || undefined;
    const bindAddr = replicaBindHost(server);
    const extraVolumes = parseExtraVolumes(app.extra_volumes);

    if (ctx.input.userId) db.updateAppDeployedBy(appId, ctx.input.userId);
    db.updateAppStatus(appId, "deploying");

    let imageTag = `${app.name}:latest`;
    const deployMode = app.deploy_mode as BuildOut["deployMode"];
    const buildOpts = {
      name: app.name,
      gitRepo: app.git_repo,
      port: containerPort,
      hostPort: first.host_port,
      envVars,
      volumeMount: app.volume_mount || undefined,
      extraVolumes,
      gitToken: githubPat,
      gitBranch: app.git_branch || undefined,
      bindAddr,
      containerName: first.container_name,
    };
    const logLine = (line: string) => {
      db.appendDeployLog(appId, `[redeploy] ${line}`);
      ctx.log(`[build] ${line}`);
    };

    if (deployMode === "compose") {
      await cloneAndComposeBuild(server.ipv4, {
        ...buildOpts,
        composeFile: app.compose_file,
        webService: app.compose_web_service,
      }, logLine);
    } else if (deployMode === "railpack") {
      const r = await cloneAndRailpackBuild(server.ipv4, buildOpts, logLine);
      if (r.imageTag) imageTag = r.imageTag;
    } else {
      const r = await cloneAndBuild(server.ipv4, {
        ...buildOpts,
        dockerfilePath: app.dockerfile_path || undefined,
        dockerContext: app.docker_context || undefined,
      }, logLine);
      if (r.imageTag) imageTag = r.imageTag;
    }

    if (replicas.length > 1) {
      const rolling = await rollingRedeploy(appId, (step, detail) => ctx.log(`[${step}] ${detail}`));
      if (!rolling.ok) db.appendDeployLog(appId, `[redeploy] Rolling update warning: ${rolling.error}`);
    }

    if (authPassword) {
      await deployAuthProxy(server.ipv4, first.container_name, authPassword, first.host_port, bindAddr, hostKey);
    } else if (app.auth_password && !authPassword) {
      await removeAuthProxy(server.ipv4, first.container_name, hostKey);
    }

    // Persist port/auth changes only after successful build.
    if (ctx.input.auth_password !== undefined) {
      db.updateAppAuthPassword(appId, ctx.input.auth_password || "");
    }
    if (ctx.input.container_port !== undefined && ctx.input.container_port !== app.container_port) {
      db.updateAppContainerPort(appId, ctx.input.container_port);
    }

    return { imageTag, deployMode, previousStatus, previousAuthPassword, previousContainerPort };
  },
};

// Swap is effectively done inside pull_and_build for the primary replica (via
// docker run in cloneAndBuild/etc.); we keep a marker step for the audit log.
const swapContainer: Step<RedeployInput, SwapOut> = {
  name: "swap_container",
  label: "Swap container",
  async run(ctx, prior) {
    const app = db.getAppUnscoped(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const build = prior["pull_and_build"] as BuildOut;
    return { containerName: app.name, oldImageTag: `${app.name}:previous` };
  },
  async compensate(ctx, _out, prior) {
    const build = prior["pull_and_build"] as BuildOut | undefined;
    if (!build) return;
    try { db.updateAppStatus(ctx.input.appId, build.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
  },
};

const syncCaddyStep: Step<RedeployInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx) {
    try {
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      db.appendDeployLog(ctx.input.appId, `[redeploy] Caddy sync warning: ${err}`);
      ctx.log(`Caddy sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const healthCheckStep: Step<RedeployInput, HealthOut> = {
  name: "health_check",
  label: "Health check",
  async run(ctx, prior) {
    const app = db.getAppUnscoped(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const server = db.getServerUnscoped(first.server_id);
    if (!server) throw new Error("Server not found");
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const build = prior["pull_and_build"] as BuildOut;
    const health = build.deployMode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, first.host_port, 5, hostKey)
      : await healthCheck(server.ipv4, first.container_name, bindAddr, first.host_port, 5, hostKey);
    db.updateAppStatus(ctx.input.appId, health.healthy ? "running" : "unhealthy");
    if (!health.healthy) {
      db.appendDeployLog(ctx.input.appId, `[health] ${health.error || "Health check failed"}`);
    }
    return { healthy: health.healthy, statusCode: health.statusCode };
  },
};

const recordDeploymentHistory: Step<RedeployInput, { deploymentId: number; gitCommit: string }> = {
  name: "record_deployment_history",
  label: "Record deployment",
  async run(ctx, prior) {
    const app = db.getAppUnscoped(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    const first = replicas[0];
    const server = first ? db.getServerUnscoped(first.server_id) : null;
    const build = prior["pull_and_build"] as BuildOut;
    let gitCommit = "unknown";
    if (server) {
      try {
        const r = await sshExec(
          server.ipv4,
          `su - deploy -c "cd /home/deploy/apps/${app.name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
          server.ssh_host_key || undefined,
        );
        gitCommit = r.stdout.trim() || "unknown";
      } catch (err) {
        ctx.log(`Failed to capture git commit: ${err}`);
      }
    }
    const row = db.insertDeployment({
      app_id: ctx.input.appId,
      image_tag: build.imageTag,
      git_commit: gitCommit,
    });
    db.appendDeployLog(ctx.input.appId, `[done] Redeployed successfully`);
    return { deploymentId: row.id, gitCommit };
  },
};

const redeployOp: OpKindDefinition<RedeployInput> = {
  kind: "redeploy",
  label: "Redeploy app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    wakeIfSleeping,
    pullAndBuild,
    swapContainer,
    syncCaddyStep,
    healthCheckStep,
    recordDeploymentHistory,
  ],
};

registerOp(redeployOp);

export default redeployOp;
export type { RedeployInput };
