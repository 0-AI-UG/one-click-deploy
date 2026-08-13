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
import { preflightBuildDiskSpace } from "../hetzner/disk-space.ts";
import { attestReplica, hashEnvironment } from "../revision.ts";
import {
  captureRemoteRevisionSnapshot,
  discardRemoteRevisionSnapshot,
  probeRemoteRevisionSnapshot,
  restoreSnapshotGitCheckout,
  type RemoteRevisionSnapshot,
} from "./_revision-snapshot.ts";

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
  remote: RemoteRevisionSnapshot;
  containerName: string;
  hostPort: number;
  containerPort: number;
  bindAddr: string;
  volumeMount: string | null;
  extraVolumes: string[];
  memoryMb: number | null;
  cpus: number | null;
  configRevision: number;
  envHash: string;
};
type SwapOut = { containerName: string; imageDigest: string };

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
    if (app.source_mode !== "image" && !/^[a-f0-9]{7,64}$/i.test(deployment.git_commit)) {
      throw new Error(`Deployment ${deployment.id} does not contain a valid Git revision`);
    }
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

function rollbackSnapshotTarget(ctx: { input: { appId: number }; opId: number }, prior: Record<string, unknown>) {
  const target = prior["load_target_deployment"] as TargetOut;
  if (!target) throw new Error("Rollback target was not loaded");
  const app = db.getApp(target.appId);
  if (!app) throw new Error("App not found");
  const replica = db.getReplica(target.replicaId);
  if (!replica) throw new Error("Replica not found");
  const server = db.getServer(target.serverId);
  if (!server) throw new Error("Server not found");
  return {
    target,
    app,
    replica,
    server,
    remote: {
      ip: server.ipv4,
      hostKey: server.ssh_host_key || undefined,
      appName: app.name,
      containerName: replica.container_name,
      opId: ctx.opId,
      sourceMode: app.source_mode,
    },
  };
}

const snapshotCurrentRevision: Step<{ appId: number }, PriorContainerSnapshot | null> = {
  name: "snapshot_current_revision",
  label: "Snapshot current revision",
  async probe(ctx, prior) {
    const current = rollbackSnapshotTarget(ctx, prior);
    const remote = await probeRemoteRevisionSnapshot(current.remote);
    if (!remote) return null;
    return {
      remote,
      containerName: current.replica.container_name,
      hostPort: current.replica.host_port,
      containerPort: current.app.container_port,
      bindAddr: replicaBindHost(current.server),
      volumeMount: current.app.volume_mount || null,
      extraVolumes: db.parseExtraVolumes(current.app.extra_volumes),
      memoryMb: current.app.memory_mb ?? null,
      cpus: current.app.cpu_limit ?? null,
      configRevision: current.app.config_revision,
      envHash: hashEnvironment(await resolveAppEnvVars(current.app)),
    };
  },
  async run(ctx, prior) {
    const current = rollbackSnapshotTarget(ctx, prior);
    const remote = await captureRemoteRevisionSnapshot(current.remote);
    if (!remote) {
      ctx.log(`No current container found for ${current.app.name}; rollback will create it without a restore point`);
      return null;
    }
    return {
      remote,
      containerName: current.replica.container_name,
      hostPort: current.replica.host_port,
      containerPort: current.app.container_port,
      bindAddr: replicaBindHost(current.server),
      volumeMount: current.app.volume_mount || null,
      extraVolumes: db.parseExtraVolumes(current.app.extra_volumes),
      memoryMb: current.app.memory_mb ?? null,
      cpus: current.app.cpu_limit ?? null,
      configRevision: current.app.config_revision,
      envHash: hashEnvironment(await resolveAppEnvVars(current.app)),
    };
  },
  async compensate(ctx, snap, prior) {
    const target = prior["load_target_deployment"] as TargetOut | undefined;
    if (!target) return;
    try { db.updateAppStatus(target.appId, target.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
    if (!snap) return;
    const app = db.getApp(target.appId);
    const server = db.getServer(target.serverId);
    if (!app || !server) return;
    const hostKey = server.ssh_host_key || undefined;
    await restoreSnapshotGitCheckout({
      ip: server.ipv4,
      hostKey,
      appName: app.name,
      containerName: snap.containerName,
      opId: ctx.opId,
      sourceMode: app.source_mode,
    }, snap.remote.gitCommit);
    await startAppReplica(server.ipv4, {
      containerName: snap.containerName,
      image: snap.remote.image,
      appName: app.name,
      network: "ocd-net",
      bindAddr: snap.bindAddr,
      hostPort: snap.hostPort,
      containerPort: snap.containerPort,
      envFilePath: snap.remote.envFilePath || undefined,
      volumeMount: snap.volumeMount || undefined,
      extraVolumes: snap.extraVolumes,
      memoryMb: snap.memoryMb ?? undefined,
      cpus: snap.cpus ?? undefined,
      configRevision: snap.configRevision,
      envHash: snap.envHash,
    }, hostKey);
    const retag = await sshExec(
      server.ipv4,
      asUser(
        `docker image rm ${app.name}:latest 2>/dev/null || true; ` +
          `docker tag ${snap.remote.image} ${app.name}:latest; ` +
          `docker image prune -f --filter label=ocd.managed=true >/dev/null 2>&1 || true`,
      ),
      hostKey,
    );
    if (retag.exitCode !== 0) {
      throw new Error(`Failed to restore ${app.name}:latest from ${snap.remote.image}: ${retag.stderr.trim() || retag.stdout.trim()}`);
    }
    const health = await probeAppHealth(app, server.ipv4, snap.containerName, snap.bindAddr, snap.hostPort, 5, hostKey);
    const replica = db.getReplica(target.replicaId);
    if (replica) db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    ctx.log(`Restored prior container image ${snap.remote.image} (healthy=${health.healthy})`);
    if (!health.healthy && !health.inconclusive) {
      throw new Error(`Rollback restored the previous container for ${app.name} but it is unhealthy`);
    }
  },
};

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
      const checkout = await sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${target.gitCommit}`), hostKey);
      if (checkout.exitCode !== 0) {
        throw new Error(`Git checkout failed for ${app.name}: ${checkout.stderr.trim() || checkout.stdout.trim()}`);
      }
    }

    const envVars = await resolveAppEnvVars(app);
    const envFilePath = (await writeEnvDeployFile(server.ipv4, app.name, envVars, hostKey)) ?? null;
    if (envFilePath) {
      const envProbe = await sshExec(server.ipv4, asUser(`test -f ${envFilePath}`), hostKey);
      if (envProbe.exitCode !== 0) throw new Error(`Environment file was not persisted for ${app.name}`);
    }
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
    const reservation = await preflightBuildDiskSpace({
      ip: server.ipv4,
      appName: app.name,
      contextPath: `${appDir}/${app.docker_context || "."}`,
      registryBacked: true,
      hostKey,
      onProgress: (line) => ctx.log(`[disk] ${line}`),
    });
    try {
      await buildAppImage(server.ipv4, {
        appDir,
        imageTag: `${app.name}:latest`,
        dockerfilePath,
        dockerContext: app.docker_context || undefined,
        onHeartbeat: () => { void reservation.refresh(); },
      }, hostKey);
      await reservation.replace(0);
    } finally {
      await reservation.release();
    }
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
    const first = db.getReplica(target.replicaId);
    if (!first) throw new Error("Replica not found");
    const hostPort = first.host_port;
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const envVars = await resolveAppEnvVars(app);
    const image = app.source_mode === "image" ? target.imageDigest : `${app.name}:latest`;
    if (!image) throw new Error("Immutable rollback target is missing its image digest");

    await startAppReplica(server.ipv4, {
      containerName: first.container_name,
      image,
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
      configRevision: app.config_revision,
      envHash: hashEnvironment(envVars),
    }, hostKey);
    const imageInspect = await sshExec(
      server.ipv4,
      asUser(`docker image inspect --format '{{.Id}}' ${image}`),
      hostKey,
    );
    const localImageId = imageInspect.stdout.trim();
    if (imageInspect.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/i.test(localImageId)) {
      throw new Error(`Started rollback image could not be identified for ${app.name}`);
    }
    return {
      containerName: first.container_name,
      imageDigest: target.imageDigest?.includes("@sha256:") ? target.imageDigest : localImageId,
    };
  },
};

const syncIngressStep: Step<{ appId: number }, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    const { syncAppIngress } = await import("../scale/traefik-manager.ts");
    await syncAppIngress(ctx.input.appId);
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
    const first = db.getReplica(target.replicaId);
    if (!first) throw new Error("Replica not found");
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = await probeAppHealth(app, server.ipv4, first.container_name, bindAddr, first.host_port, 10, hostKey);
    if (!app.health_check && health.healthy) {
      db.appendDeployLog(target.appId, `[health] HTTP probe disabled; container is running`);
    }
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    if (!health.healthy) {
      // Fail the op so the earlier completed snapshot step restores the prior
      // image instead of leaving the app on a broken rolled-back version.
      db.appendDeployLog(target.appId, `[health] Rollback target unhealthy: ${health.error || `HTTP ${health.statusCode ?? "no response"}`}`);
      throw new Error(`App did not become healthy after rollback: ${health.error || "health check failed"}`);
    }
    const swap = prior["swap_container"] as SwapOut;
    const envHash = hashEnvironment(await resolveAppEnvVars(app));
    db.updateReplicaStatus(first.id, "attesting");
    const attestation = await attestReplica(app, first, server, {
      imageDigest: swap.imageDigest,
      envHash,
      configRevision: app.config_revision,
    });
    if (!attestation.ok) {
      throw new Error(`Rollback revision attestation failed: ${attestation.error}`);
    }
    db.updateReplicaStatus(first.id, "running");
    return { healthy: health.healthy };
  },
};

const recordRollback: Step<RollbackInput, { deploymentId: number }> = {
  name: "record_rollback",
  label: "Record rollback",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const swap = prior["swap_container"] as SwapOut;
    const sourceDeployment = db.getDeployment(ctx.input.deploymentId);
    const row = db.insertDeployment({
      operation_id: ctx.opId,
      app_id: target.appId,
      image_tag: target.imageTag,
      image_digest: swap.imageDigest,
      image_size_bytes: sourceDeployment?.image_size_bytes,
      archive_size_bytes: sourceDeployment?.archive_size_bytes,
      transfer_size_bytes: sourceDeployment?.transfer_size_bytes,
      // Keep revision identity usable by later rollback/promotion operations;
      // provenance belongs in `source`, not in the Git SHA field.
      git_commit: target.gitCommit,
      config_revision: db.getApp(target.appId)?.config_revision ?? 1,
      source: `rollback-from-deployment-${ctx.input.deploymentId}`,
    });
    db.appendDeployLog(
      target.appId,
      `[rollback] Rolled back to deployment ${ctx.input.deploymentId} (${target.imageTag})`,
    );
    return { deploymentId: row.id };
  },
};

const discardRevisionSnapshot: Step<{ appId: number }, { ok: true }> = {
  name: "discard_revision_snapshot",
  label: "Release recovery snapshot",
  async run(ctx, prior) {
    try {
      const current = rollbackSnapshotTarget(ctx, prior);
      await discardRemoteRevisionSnapshot(current.remote);
    } catch (err) {
      ctx.log(`Failed to discard revision snapshot: ${err}`);
    }
    return { ok: true };
  },
};

const rollbackOp: OpKindDefinition<RollbackInput> = {
  kind: "rollback",
  label: "Rollback app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    loadTargetDeployment,
    snapshotCurrentRevision,
    checkoutTarget,
    rebuildImage,
    swapContainer,
    syncIngressStep,
    healthCheckStep,
    recordRollback,
    discardRevisionSnapshot,
  ],
};

registerOp(rollbackOp as OpKindDefinition<any>);

export default rollbackOp;
export type { RollbackInput, TargetOut };
// Shared with ops/promote.ts, which supplies its own `load_target_deployment`
// step (producing a TargetOut for the DEST app pinned to the source commit) and
// reuses these to check out / rebuild / swap / sync / health-check it.
export {
  snapshotCurrentRevision,
  checkoutTarget,
  rebuildImage,
  swapContainer,
  syncIngressStep,
  healthCheckStep,
  discardRevisionSnapshot,
};
