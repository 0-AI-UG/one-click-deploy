import * as db from "../../shared/db.ts";
import {
  sshExec,
  cloneRepo,
  cloneAndBuild,
  cloneAndComposeBuild,
  cloneAndRailpackBuild,
  deployAuthProxy,
  removeAuthProxy,
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
type SetDeployingOut = { previousStatus: string };
type BuildOut = {
  imageTag: string;
  deployMode: "dockerfile" | "compose" | "railpack";
  previousAuthPassword: string;
  previousContainerPort: number;
};
type HealthOut = { healthy: boolean; statusCode?: number };

function parseExtraVolumes(raw: string): string[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const wakeIfSleeping: Step<RedeployInput, WakeOut> = {
  name: "wake_if_sleeping",
  label: "Wake app",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (app.status !== "sleeping") return { woke: false };
    const result = await wakeApp(ctx.input.appId);
    if (!result.ok) throw new Error(`Failed to wake sleeping app: ${result.error}`);
    return { woke: true };
  },
};

const cloneRepoStep: Step<RedeployInput, { ok: true }> = {
  name: "clone_repo",
  label: "Clone repository",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const server = db.getServer(replicas[0].server_id);
    if (!server) throw new Error("Server not found");
    const githubPat = (await resolveGitHubToken(ctx.input.userId)) || undefined;
    await cloneRepo(server.ipv4, app.name, app.git_repo, githubPat, (line) => {
      db.appendDeployLog(ctx.input.appId, `[clone] ${line}`);
      ctx.log(`[clone] ${line}`);
    }, app.git_branch || undefined);
    return { ok: true };
  },
};

const setDeploying: Step<RedeployInput, SetDeployingOut> = {
  name: "set_deploying",
  label: "Mark deploying",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const previousStatus = app.status;
    if (ctx.input.userId) db.updateAppDeployedBy(ctx.input.appId, ctx.input.userId);
    db.updateAppStatus(ctx.input.appId, "deploying");
    return { previousStatus };
  },
  async compensate(ctx, _out, prior) {
    const info = prior["set_deploying"] as SetDeployingOut | undefined;
    if (!info) return;
    try { db.updateAppStatus(ctx.input.appId, info.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
  },
};

const pullAndBuild: Step<RedeployInput, BuildOut> = {
  name: "pull_and_build",
  label: "Build container",
  async run(ctx) {
    const { appId } = ctx.input;
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const server = db.getServer(first.server_id);
    if (!server) throw new Error("Server not found");

    const previousAuthPassword = app.auth_password;
    const previousContainerPort = app.container_port;

    const containerPort = ctx.input.container_port ?? app.container_port;
    const envVars = await resolveAppEnvVars(app);
    const githubPat = (await resolveGitHubToken(ctx.input.userId)) || undefined;
    const bindAddr = replicaBindHost(server);
    const extraVolumes = parseExtraVolumes(app.extra_volumes);

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
      skipClone: true,
      memoryMb: app.memory_mb || undefined,
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

    return { imageTag, deployMode, previousAuthPassword, previousContainerPort };
  },
};

const rollExtraReplicas: Step<RedeployInput, { ok: true }> = {
  name: "roll_extra_replicas",
  label: "Roll extra replicas",
  async run(ctx) {
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length <= 1) return { ok: true };
    const rolling = await rollingRedeploy(ctx.input.appId, (step, detail) => ctx.log(`[${step}] ${detail}`));
    if (!rolling.ok) db.appendDeployLog(ctx.input.appId, `[redeploy] Rolling update warning: ${rolling.error}`);
    return { ok: true };
  },
  async compensate(ctx) {
    // Rolling redeploy replaces replicas in-place; we can't undo the image
    // swap, but we can clear any leftover 'draining' markers and re-sync the
    // ingress so traffic stops routing to half-state replicas.
    try {
      const replicas = db.getReplicas(ctx.input.appId);
      for (const r of replicas) {
        if (r.status === "draining") {
          try { db.updateReplicaStatus(r.id, "running"); } catch { /* ignore */ }
        }
      }
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Failed to re-sync after roll_extra_replicas compensate: ${err}`);
    }
  },
};

const manageAuthProxy: Step<RedeployInput, { ok: true }> = {
  name: "manage_auth_proxy",
  label: "Manage auth proxy",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) return { ok: true };
    const first = replicas[0];
    const server = db.getServer(first.server_id);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const bindAddr = replicaBindHost(server);

    const desired = ctx.input.auth_password !== undefined
      ? (ctx.input.auth_password || "")
      : app.auth_password;
    if (desired) {
      await deployAuthProxy(server.ipv4, first.container_name, desired, first.host_port, bindAddr, hostKey);
    } else if (app.auth_password && !desired) {
      await removeAuthProxy(server.ipv4, first.container_name, hostKey);
    }

    // Persist port/auth changes after the proxy state is in place.
    if (ctx.input.auth_password !== undefined) {
      db.updateAppAuthPassword(ctx.input.appId, ctx.input.auth_password || "");
    }
    if (ctx.input.container_port !== undefined && ctx.input.container_port !== app.container_port) {
      db.updateAppContainerPort(ctx.input.appId, ctx.input.container_port);
    }
    return { ok: true };
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
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const server = db.getServer(first.server_id);
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
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    const first = replicas[0];
    const server = first ? db.getServer(first.server_id) : null;
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
      source: ctx.trigger === "ui" ? "manual" : ctx.trigger,
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
    cloneRepoStep,
    setDeploying,
    pullAndBuild,
    rollExtraReplicas,
    manageAuthProxy,
    syncCaddyStep,
    healthCheckStep,
    recordDeploymentHistory,
  ],
};

registerOp(redeployOp as OpKindDefinition<any>);

export default redeployOp;
export type { RedeployInput };
