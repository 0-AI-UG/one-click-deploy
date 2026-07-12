import * as db from "../../shared/db.ts";
import {
  sshExec,
  cloneRepo,
  cloneAndBuild,
  probeAppHealth,
  startAppReplica,
} from "../../shared/remote/index.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { rollingRedeploy } from "../scale-api.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RedeployInput = {
  appId: number;
  container_port?: number;
  userId?: string;
};

type WakeOut = { woke: boolean };
type SetDeployingOut = { previousStatus: string };
// Everything needed to re-run the previous (last-known-good) container if the
// new build fails its health check. `image` is a dedicated `:rollback` tag we
// pin before building so the new `docker build -t :latest` can't orphan it.
type RollbackSnapshot = {
  image: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  bindAddr: string;
  envFilePath: string | null;
  volumeMount: string | null;
  extraVolumes: string[];
  memoryMb: number | null;
};
type BuildOut = {
  imageTag: string;
  rollback: RollbackSnapshot | null;
};
type HealthOut = { healthy: boolean; statusCode?: number };

const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

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
    }, app.git_branch || undefined, server.ssh_host_key || undefined);
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
    // If a later compensation (e.g. pull_and_build's rollback) already set a
    // concrete running/unhealthy status, don't clobber it with the stale one.
    const app = db.getApp(ctx.input.appId);
    if (app && app.status !== "deploying") return;
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

    const containerPort = ctx.input.container_port ?? app.container_port;
    const envVars = await resolveAppEnvVars(app);
    const githubPat = (await resolveGitHubToken(ctx.input.userId)) || undefined;
    const bindAddr = replicaBindHost(server);
    const extraVolumes = db.parseExtraVolumes(app.extra_volumes);

    let imageTag = `${app.name}:latest`;

    // Snapshot the currently-running image + run config so a failed redeploy
    // can roll back to the last-known-good container instead of leaving the
    // app unhealthy. Retag it to `${name}:rollback` BEFORE building so the
    // upcoming `docker build -t :latest` doesn't orphan it (pruneAfterBuild
    // preserves the `:rollback` tag).
    let rollback: RollbackSnapshot | null = null;
    try {
      const insp = await sshExec(
        server.ipv4,
        asUser(`docker inspect --format='{{.Image}}' ${first.container_name} 2>/dev/null || true`),
        server.ssh_host_key || undefined,
      );
      const prevImageId = insp.stdout.trim();
      if (prevImageId) {
        const rollbackTag = `${app.name}:rollback`;
        await sshExec(server.ipv4, asUser(`docker tag ${prevImageId} ${rollbackTag}`), server.ssh_host_key || undefined);
        rollback = {
          image: rollbackTag,
          containerName: first.container_name,
          hostPort: first.host_port,
          // Roll back to the port the *previous* container actually used.
          containerPort: app.container_port,
          bindAddr,
          envFilePath: Object.keys(envVars).length > 0 ? `/home/deploy/apps/${app.name}/.env.deploy` : null,
          volumeMount: app.volume_mount || null,
          extraVolumes,
          memoryMb: app.memory_mb ?? null,
        };
      }
    } catch (err) {
      ctx.log(`Could not snapshot previous image for rollback: ${err}`);
    }

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
      hostKey: server.ssh_host_key || undefined,
    };
    const logLine = (line: string) => {
      db.appendDeployLog(appId, `[redeploy] ${line}`);
      ctx.log(`[build] ${line}`);
    };

    const r = await cloneAndBuild(server.ipv4, {
      ...buildOpts,
      dockerfilePath: app.dockerfile_path || undefined,
      dockerContext: app.docker_context || undefined,
    }, logLine);
    if (r.imageTag) imageTag = r.imageTag;

    return { imageTag, rollback };
  },
  // If a later step fails (e.g. the new build never becomes healthy), restore
  // the previous container so the app keeps serving instead of going unhealthy.
  async compensate(ctx, out) {
    const snap = (out as BuildOut | undefined)?.rollback;
    if (!snap) return;
    try {
      const app = db.getApp(ctx.input.appId);
      const replicas = db.getReplicas(ctx.input.appId);
      const first = replicas[0];
      const server = first ? db.getServer(first.server_id) : null;
      if (!app || !server) return;
      const hostKey = server.ssh_host_key || undefined;
      await startAppReplica(server.ipv4, {
        containerName: snap.containerName,
        image: snap.image,
        appName: app.name,
        network: null,
        bindAddr: snap.bindAddr,
        hostPort: snap.hostPort,
        containerPort: snap.containerPort,
        envFilePath: snap.envFilePath || undefined,
        volumeMount: snap.volumeMount || undefined,
        extraVolumes: snap.extraVolumes,
        memoryMb: snap.memoryMb ?? undefined,
      }, hostKey);
      const health = await probeAppHealth(app, server.ipv4, snap.containerName, snap.bindAddr, snap.hostPort, 5, hostKey);
      if (first) db.updateReplicaStatus(first.id, health.healthy ? "running" : "unhealthy");
      db.updateAppStatus(ctx.input.appId, health.healthy ? "running" : "unhealthy");
      db.appendDeployLog(ctx.input.appId, `[rollback] Restored previous image after failed redeploy (healthy=${health.healthy})`);
      ctx.log(`Rolled back to previous image ${snap.image} (healthy=${health.healthy})`);
      // Drop the rollback tag now that it's the live image again; leaving it
      // would pin the image and defeat the periodic prune.
      await sshExec(server.ipv4, asUser(`docker rmi ${snap.image} 2>/dev/null || true`), hostKey).catch(() => {});
    } catch (err) {
      ctx.log(`Failed to roll back to previous container: ${err}`);
    }
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
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Failed to re-sync after roll_extra_replicas compensate: ${err}`);
    }
  },
};

const persistSettings: Step<RedeployInput, { ok: true }> = {
  name: "persist_settings",
  label: "Persist settings",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    // Only the container port needs a rebuild path (the container binds it), so
    // it persists here before the fresh container starts. Password protection is
    // pure ingress config now and lives on PUT /api/apps/:id/ingress instead.
    if (ctx.input.container_port !== undefined && ctx.input.container_port !== app.container_port) {
      db.updateAppContainerPort(ctx.input.appId, ctx.input.container_port);
    }
    return { ok: true };
  },
};

const syncIngressStep: Step<RedeployInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      db.appendDeployLog(ctx.input.appId, `[redeploy] Ingress sync warning: ${err}`);
      ctx.log(`Ingress sync warning: ${err}`);
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
    // Generous window (10 attempts) so a slow-booting app isn't failed
    // prematurely — but if it never comes up, throw so the op fails and
    // pull_and_build's compensate rolls back to the previous image.
    const health = await probeAppHealth(app, server.ipv4, first.container_name, bindAddr, first.host_port, 10, hostKey);
    if (!app.health_check && health.healthy) {
      db.appendDeployLog(ctx.input.appId, `[health] HTTP probe disabled; container is running`);
    }
    db.updateAppStatus(ctx.input.appId, health.healthy ? "running" : "unhealthy");
    if (!health.healthy) {
      const detail = health.error || `HTTP ${health.statusCode ?? "no response"}`;
      db.appendDeployLog(ctx.input.appId, `[health] ${detail}`);
      throw new Error(`App did not become healthy after redeploy: ${detail}`);
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
      // Redeploy succeeded — drop the rollback tag so it stops pinning the old
      // image and the periodic prune can reclaim it.
      if (build?.rollback) {
        await sshExec(server.ipv4, asUser(`docker rmi ${build.rollback.image} 2>/dev/null || true`), server.ssh_host_key || undefined).catch(() => {});
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
    persistSettings,
    syncIngressStep,
    healthCheckStep,
    recordDeploymentHistory,
  ],
};

registerOp(redeployOp as OpKindDefinition<any>);

export default redeployOp;
export type { RedeployInput };
