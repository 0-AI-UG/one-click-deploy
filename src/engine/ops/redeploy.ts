import * as db from "../../shared/db.ts";
import {
  sshExec,
  cloneRepo,
  cloneAndBuild,
  pullImmutableImageAndRun,
  probeAppHealth,
  startAppReplica,
} from "../../shared/remote/index.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { rollingRedeploy } from "../scale/index.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";

type RedeployInput = {
  appId: number;
  userId?: string;
  /** Immutable commit selected by a webhook. Manual redeploys follow git_branch. */
  gitSha?: string;
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
  cpus: number | null;
};
type BuildOut = {
  imageTag: string;
  imageDigest?: string;
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
    if (app.source_mode === "image") {
      if (ctx.input.gitSha) throw new Error("Webhook commit redeploy is not valid for an image artifact app");
      ctx.log("Immutable image deployment: no Git clone required");
      return { ok: true };
    }
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const server = db.getServer(replicas[0].server_id);
    if (!server) throw new Error("Server not found");
    const githubPat = (await resolveGitHubToken(ctx.input.userId)) || undefined;
    await cloneRepo(server.ipv4, app.name, app.git_repo, githubPat, (line) => {
      db.appendDeployLog(ctx.input.appId, `[clone] ${line}`);
      ctx.log(`[clone] ${line}`);
    }, app.git_branch || undefined, server.ssh_host_key || undefined);
    if (ctx.input.gitSha) {
      if (!/^[0-9a-f]{7,64}$/i.test(ctx.input.gitSha)) throw new Error("Invalid webhook commit SHA");
      const checkedOut = await sshExec(
        server.ipv4,
        asUser(`cd /home/deploy/apps/${app.name} && git checkout --detach ${ctx.input.gitSha}`),
        server.ssh_host_key || undefined,
      );
      if (checkedOut.exitCode !== 0) {
        throw new Error(`Could not check out webhook commit ${ctx.input.gitSha}`);
      }
      ctx.log(`Checked out webhook commit ${ctx.input.gitSha}`);
    }
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

    const containerPort = app.container_port;
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
          cpus: app.cpu_limit ?? null,
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
      cpus: app.cpu_limit || undefined,
      hostKey: server.ssh_host_key || undefined,
      configRevision: app.config_revision,
      envHash: hashEnvironment(envVars),
    };
    const logLine = (line: string) => {
      db.appendDeployLog(appId, `[redeploy] ${line}`);
      ctx.log(`[build] ${line}`);
    };

    const r = app.source_mode === "image"
      ? await pullImmutableImageAndRun(server.ipv4, {
          ...buildOpts,
          imageRef: app.image_ref,
        }, logLine)
      : await cloneAndBuild(server.ipv4, {
          ...buildOpts,
          dockerfilePath: app.dockerfile_path || undefined,
          dockerContext: app.docker_context || undefined,
          buildCacheRef: app.build_cache_ref || undefined,
          reserveArchiveSpace:
            app.desired_replicas > 1 && db.getSettings().allow_archive_image_transfer === "1",
        }, logLine);
    if (r.imageTag) imageTag = r.imageTag;

    return {
      imageTag,
      imageDigest: "imageDigest" in r ? r.imageDigest : undefined,
      rollback,
    };
  },
  // If a later step fails (e.g. the new build never becomes healthy), restore
  // the previous container so the app keeps serving instead of going unhealthy.
  async compensate(ctx, out) {
    const snap = (out as BuildOut | undefined)?.rollback;
    if (!snap) return;
    const app = db.getApp(ctx.input.appId);
    const replicas = db.getReplicas(ctx.input.appId);
    const first = replicas[0];
    const server = first ? db.getServer(first.server_id) : null;
    if (!app || !server) return;
    const hostKey = server.ssh_host_key || undefined;
    // Restore the previous container from the pinned :rollback image. Do NOT
    // swallow failures here: if the restore throws (image gone) or comes back
    // unhealthy, the app is left with no working container, and that must
    // surface as `compensation_failed` (reconciler retries, operators see it)
    // rather than be hidden behind a clean-looking `compensated` status. That
    // silent-success swallow is exactly why a failed rollback previously left
    // an app dead while the op reported it had been compensated.
    await startAppReplica(server.ipv4, {
      containerName: snap.containerName,
      image: snap.image,
      appName: app.name,
      network: "ocd-net",
      bindAddr: snap.bindAddr,
      hostPort: snap.hostPort,
      containerPort: snap.containerPort,
      envFilePath: snap.envFilePath || undefined,
      volumeMount: snap.volumeMount || undefined,
      extraVolumes: snap.extraVolumes,
      memoryMb: snap.memoryMb ?? undefined,
      cpus: snap.cpus ?? undefined,
    }, hostKey);
    // The failed candidate still owns :latest. Restore the convenience tag to
    // the known-good image and let Docker discard candidate-only layers.
    await sshExec(
      server.ipv4,
      asUser(
        `docker image rm ${app.name}:latest 2>/dev/null || true; ` +
          `docker tag ${snap.image} ${app.name}:latest; ` +
          `docker image prune -f --filter label=ocd.managed=true >/dev/null 2>&1 || true`,
      ),
      hostKey,
    );
    const health = await probeAppHealth(app, server.ipv4, snap.containerName, snap.bindAddr, snap.hostPort, 5, hostKey);
    if (first) db.updateReplicaStatus(first.id, health.healthy ? "running" : "unhealthy");
    db.updateAppStatus(ctx.input.appId, health.healthy ? "running" : "unhealthy");
    db.appendDeployLog(ctx.input.appId, `[rollback] Restored previous image after failed redeploy (healthy=${health.healthy})`);
    ctx.log(`Rolled back to previous image ${snap.image} (healthy=${health.healthy})`);
    // Keep the rollback tag pinned. The next redeploy replaces it with the
    // then-current revision, and environment-only reloads can safely recover
    // without relying on a mutable :latest tag.
    // The restore ran but the app still isn't serving — escalate. An
    // `inconclusive` probe (couldn't reach the host over SSH) is not proof of
    // failure, so don't escalate on that alone.
    if (!health.healthy && !health.inconclusive) {
      throw new Error(`Rollback restored the previous container for ${app.name} but it is unhealthy`);
    }
  },
};

const rollExtraReplicas: Step<RedeployInput, { ok: true }> = {
  name: "roll_extra_replicas",
  label: "Roll extra replicas",
  async run(ctx, prior) {
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length <= 1) return { ok: true };
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const build = prior["pull_and_build"] as BuildOut;
    const envVars = await resolveAppEnvVars(app);
    const rolling = await rollingRedeploy(
      ctx.input.appId,
      (step, detail) => ctx.log(`[${step}] ${detail}`),
      {
        imageDigest: build.imageDigest || build.imageTag,
        envHash: hashEnvironment(envVars),
        configRevision: app.config_revision,
      },
    );
    if (!rolling.ok) throw new Error(`Rolling update failed: ${rolling.error}`);
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

const syncIngressStep: Step<RedeployInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    await syncAppIngress(ctx.input.appId);
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
    const build = prior["pull_and_build"] as BuildOut | undefined;
    const envVars = await resolveAppEnvVars(app);
    const expected = {
      imageDigest: build?.imageDigest || build?.imageTag || latestDesiredImage(app),
      envHash: hashEnvironment(envVars),
      configRevision: app.config_revision,
    };
    let lastStatus: number | undefined;
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) throw new Error(`Server ${replica.server_id} not found`);
      const bindAddr = replicaBindHost(server);
      const health = await probeAppHealth(app, server.ipv4, replica.container_name, bindAddr, replica.host_port, 10, server.ssh_host_key || undefined);
      lastStatus = health.statusCode;
      if (!health.healthy) {
        db.updateReplicaStatus(replica.id, "unhealthy");
        throw new Error(`Replica ${replica.id} did not become healthy after redeploy: ${health.error || `HTTP ${health.statusCode ?? "no response"}`}`);
      }
      db.updateReplicaStatus(replica.id, "attesting");
      const attestation = await attestReplica(app, replica, server, expected);
      if (!attestation.ok) throw new Error(`Replica ${replica.id} revision attestation failed: ${attestation.error}`);
      db.updateReplicaStatus(replica.id, "running");
    }
    db.appendDeployLog(
      ctx.input.appId,
      app.health_check_mode === "container" || !app.health_check
        ? `[health] all ${replicas.length} replica(s) healthy and attested; HTTP probe disabled; container is running`
        : `[health] all ${replicas.length} replica(s) passed ${app.health_check_mode || "http"} readiness and attestation`,
    );
    db.updateAppStatus(ctx.input.appId, "running");
    db.markAppEnvironmentFresh(ctx.input.appId);
    return { healthy: true, statusCode: lastStatus };
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
    let gitCommit = app.source_mode === "image" ? "artifact" : "unknown";
    if (server && app.source_mode !== "image") {
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
      image_digest: build.imageDigest || app.image_ref || "",
      env_hash: hashEnvironment(await resolveAppEnvVars(app)),
      git_commit: gitCommit,
      config_revision: app.config_revision ?? 1,
      source: ctx.trigger === "ui" ? "manual" : ctx.trigger,
    });
    db.clearAppRolloutRequest(ctx.input.appId, app.config_revision);
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
    syncIngressStep,
    healthCheckStep,
    recordDeploymentHistory,
  ],
};

registerOp(redeployOp as OpKindDefinition<any>);

export default redeployOp;
export type { RedeployInput };
