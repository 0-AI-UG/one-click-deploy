import * as db from "../../shared/db.ts";
import {
  sshExec,
  probeAppHealth,
  startAppReplica,
  writeEnvDeployFile,
  buildAppImage,
  findDockerfile,
  pullImmutableImage,
} from "../../shared/remote/index.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RollbackInput = {
  appId: number;
  deploymentId: number;
};

type TargetOut = {
  appId: number;
  replicaId: number;
  serverId: number;
  gitCommit: string;
  imageTag: string;
  imageDigest?: string;
  previousStatus: string;
};

type CheckoutOut = { envFilePath: string | null };
type RebuildOut = { dockerfilePath: string | null };
type PriorContainerSnapshot = {
  image: string;
  envFilePath: string | null;
  hostPort: number;
  containerPort: number;
  bindAddr: string;
  volumeMount: string | null;
  extraVolumes: string[];
} | null;
type SwapOut = { containerName: string; priorSnapshot: PriorContainerSnapshot };

const loadTargetDeployment: Step<RollbackInput, TargetOut> = {
  name: "load_target_deployment",
  label: "Load target deployment",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const deployment = db.getDeployment(ctx.input.deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.app_id !== ctx.input.appId) throw new Error("Deployment does not belong to this app");
    return {
      appId: ctx.input.appId,
      replicaId: first.id,
      serverId: first.server_id,
      gitCommit: deployment.git_commit,
      imageTag: deployment.image_tag,
      imageDigest: deployment.image_digest || undefined,
      previousStatus: app.status,
    };
  },
};

const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

// Reused by the promote op. These steps mutate the DEST/target app purely from
// its `load_target_deployment` prior output (a TargetOut carrying the app id,
// first replica/server, the git commit to check out, and the pre-op status), so
// they only need `{ appId }` on the input — the promote op supplies its own
// first step producing the same `load_target_deployment` shape. Runtime
// behaviour is identical to before; only the input type param was widened.
const checkoutTarget: Step<{ appId: number }, CheckoutOut> = {
  name: "checkout_target",
  label: "Checkout target commit",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const appDir = `/home/deploy/apps/${app.name}`;

    if (app.source_mode !== "image") {
      await sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${target.gitCommit}`), hostKey);
    }

    const envVars = await resolveAppEnvVars(app);
    const envFilePath = (await writeEnvDeployFile(server.ipv4, app.name, envVars, hostKey)) ?? null;
    return { envFilePath };
  },
};

const rebuildImage: Step<{ appId: number }, RebuildOut> = {
  name: "rebuild_image",
  label: "Rebuild image",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const appDir = `/home/deploy/apps/${app.name}`;
    if (app.source_mode === "image") {
      if (!target.imageDigest?.includes("@sha256:")) {
        throw new Error("Rollback target predates immutable image digest history");
      }
      const token = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
      await pullImmutableImage(server.ipv4, {
        name: app.name,
        imageRef: target.imageDigest,
        gitToken: token,
        hostKey,
      }, (line) => ctx.log(`[pull] ${line}`));
      return { dockerfilePath: null };
    }

    let dockerfilePath = app.dockerfile_path?.replace(/^\/+/, "");
    if (!dockerfilePath) {
      dockerfilePath = await findDockerfile(server.ipv4, appDir, hostKey);
      if (!dockerfilePath) throw new Error("No Dockerfile found in repository for rollback");
    }
    // Shares cloneAndBuild's build invocation so the rebuilt image carries the
    // OCD_IMAGE_LABEL — without it a rollback image escapes the scoped prune.
    await buildAppImage(server.ipv4, {
      appDir,
      imageTag: `${app.name}:latest`,
      dockerfilePath,
      dockerContext: app.docker_context || undefined,
    }, hostKey);
    return { dockerfilePath };
  },
};

const swapContainer: Step<{ appId: number }, SwapOut> = {
  name: "swap_container",
  label: "Swap container",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const checkout = prior["checkout_target"] as CheckoutOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const hostPort = first.host_port;
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;

    let priorSnapshot: PriorContainerSnapshot = null;
    // Snapshot the running container before removing so compensate can
    // restart the prior image if any later step in this op fails.
    try {
      const inspect = await sshExec(
        server.ipv4,
        `docker inspect ${app.name} --format '{{.Config.Image}}' 2>/dev/null || true`,
        hostKey,
      );
      const priorImage = inspect.stdout.trim();
      if (priorImage) {
        priorSnapshot = {
          image: priorImage,
          envFilePath: checkout.envFilePath,
          hostPort,
          containerPort: app.container_port,
          bindAddr,
          volumeMount: app.volume_mount || null,
          extraVolumes: db.parseExtraVolumes(app.extra_volumes),
        };
      }
    } catch (err) {
      ctx.log(`Failed to snapshot prior container (compensate may be no-op): ${err}`);
    }

    await startAppReplica(server.ipv4, {
      containerName: app.name,
      image: `${app.name}:latest`,
      appName: app.name,
      network: "ocd-net",
      bindAddr,
      hostPort,
      containerPort: app.container_port,
      envFilePath: checkout.envFilePath || undefined,
      volumeMount: app.volume_mount || undefined,
      extraVolumes: db.parseExtraVolumes(app.extra_volumes),
      memoryMb: app.memory_mb || undefined,
      cpus: app.cpu_limit || undefined,
    }, hostKey);
    return { containerName: app.name, priorSnapshot };
  },
  async compensate(ctx, out, prior) {
    const target = prior["load_target_deployment"] as TargetOut | undefined;
    if (!target) return;
    try { db.updateAppStatus(target.appId, target.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
    // Restore the prior container image if we captured one. This is a RESTORE
    // (bring the app back to its pre-rollback serving state), so do NOT swallow
    // failures: if the restart throws or the restored container comes back
    // unhealthy the app is left dead, and that must surface as
    // `compensation_failed` (reconciler retries, operators see it) rather than
    // hide behind a clean `compensated`. startAppReplica removes any stale
    // same-named container first, so re-running the compensate is safe.
    const snap = out?.priorSnapshot;
    if (!snap) return;
    const app = db.getApp(target.appId);
    const server = db.getServer(target.serverId);
    if (!app || !server) return;
    const hostKey = server.ssh_host_key || undefined;
    await startAppReplica(server.ipv4, {
      containerName: app.name,
      image: snap.image,
      appName: app.name,
      network: "ocd-net",
      bindAddr: snap.bindAddr,
      hostPort: snap.hostPort,
      containerPort: snap.containerPort,
      envFilePath: snap.envFilePath || undefined,
      volumeMount: snap.volumeMount || undefined,
      extraVolumes: snap.extraVolumes,
      memoryMb: app.memory_mb || undefined,
      cpus: app.cpu_limit || undefined,
    }, hostKey);
    const health = await probeAppHealth(app, server.ipv4, app.name, snap.bindAddr, snap.hostPort, 5, hostKey);
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    if (first) db.updateReplicaStatus(first.id, health.healthy ? "running" : "unhealthy");
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    ctx.log(`Restored prior container image ${snap.image} (healthy=${health.healthy})`);
    // An `inconclusive` probe (couldn't reach the host over SSH) is not proof
    // of failure, so don't escalate on that alone.
    if (!health.healthy && !health.inconclusive) {
      throw new Error(`Rollback restored the previous container for ${app.name} but it is unhealthy`);
    }
  },
};

const syncIngressStep: Step<{ appId: number }, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    try {
      const { syncAppIngress } = await import("../scale/traefik-manager.ts");
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const healthCheckStep: Step<{ appId: number }, { healthy: boolean }> = {
  name: "health_check",
  label: "Health check",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = await probeAppHealth(app, server.ipv4, app.name, bindAddr, first.host_port, 10, hostKey);
    if (!app.health_check && health.healthy) {
      db.appendDeployLog(target.appId, `[health] HTTP probe disabled; container is running`);
    }
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    if (!health.healthy) {
      // Fail the op so swap_container's compensate restores the prior image
      // instead of leaving the app on a broken rolled-back version.
      db.appendDeployLog(target.appId, `[health] Rollback target unhealthy: ${health.error || `HTTP ${health.statusCode ?? "no response"}`}`);
      throw new Error(`App did not become healthy after rollback: ${health.error || "health check failed"}`);
    }
    return { healthy: health.healthy };
  },
};

const recordRollback: Step<RollbackInput, { deploymentId: number }> = {
  name: "record_rollback",
  label: "Record rollback",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const row = db.insertDeployment({
      app_id: target.appId,
      image_tag: target.imageTag,
      image_digest: target.imageDigest || "",
      git_commit: `rollback-from-${target.gitCommit}`,
      config_revision: db.getApp(target.appId)?.config_revision ?? 1,
    });
    db.appendDeployLog(
      target.appId,
      `[rollback] Rolled back to deployment ${ctx.input.deploymentId} (${target.imageTag})`,
    );
    return { deploymentId: row.id };
  },
};

const rollbackOp: OpKindDefinition<RollbackInput> = {
  kind: "rollback",
  label: "Rollback app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    loadTargetDeployment,
    checkoutTarget,
    rebuildImage,
    swapContainer,
    syncIngressStep,
    healthCheckStep,
    recordRollback,
  ],
};

registerOp(rollbackOp as OpKindDefinition<any>);

export default rollbackOp;
export type { RollbackInput, TargetOut };
// Shared with ops/promote.ts, which supplies its own `load_target_deployment`
// step (producing a TargetOut for the DEST app pinned to the source commit) and
// reuses these to check out / rebuild / swap / sync / health-check it.
export { checkoutTarget, rebuildImage, swapContainer, syncIngressStep, healthCheckStep };
