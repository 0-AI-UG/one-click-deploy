import * as db from "../../shared/db.ts";
import {
  pullImmutableImageAndRun,
  probeAppHealth,
  startAppReplica,
  runAppPostStartCommand,
} from "../../shared/remote/index.ts";
import {
  platformEnvVars,
  projectEnvVars,
  resolveAppEnvVars,
  resolveEnvVarsForDeploy,
} from "../../shared/env-crypto.ts";
import { rollingRedeploy } from "../scale/index.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { DeployRequest } from "../../shared/rpc.ts";
import {
  applyAppConfig,
  mergeDeployRequestWithExistingApp,
  resolveDeployRequestEnvironmentIds,
} from "../../shared/app-config.ts";
import {
  captureRemoteRevisionSnapshot,
  discardRemoteRevisionSnapshot,
  probeRemoteRevisionSnapshot,
  type RemoteRevisionSnapshot,
} from "./_revision-snapshot.ts";
import { commitManifestDeliverySource } from "../manifest-delivery-source.ts";

type RedeployInput = {
  appId: number;
  userId?: string;
  /** Optional source provenance supplied by external CI. Never used to fetch source. */
  gitCommit?: string;
  candidate?: DeployRequest;
  /** Release-only bridge for an unchanged migration-97 volume sentinel. */
  allowUnchangedLegacyVolumeIntent?: boolean;
};

type WakeOut = { woke: boolean };
type SetDeployingOut = { previousStatus: string };
// Everything needed to re-run the previous immutable artifact if the candidate
// fails its health check.
type RollbackSnapshot = {
  remote: RemoteRevisionSnapshot;
  containerName: string;
  hostPort: number;
  containerPort: number;
  bindAddr: string;
  volumeMount: string | null;
  extraVolumes: string[];
  memoryMb: number | null;
  cpus: number | null;
  command: string[];
  capAdd: string[];
  configRevision: number;
  envHash: string;
};
type ArtifactOut = {
  imageTag: string;
  imageDigest?: string;
  imageBytes?: number;
};
type HealthOut = { healthy: boolean; statusCode?: number };

function effectiveCandidate(app: AppRow, input: RedeployInput): DeployRequest | null {
  return input.candidate
    ? mergeDeployRequestWithExistingApp(app, resolveDeployRequestEnvironmentIds(input.candidate))
    : null;
}

function candidateApp(app: AppRow, candidate: DeployRequest | null): AppRow {
  if (!candidate) return app;
  const mode = candidate.health_check_mode ?? (candidate.health_check === false ? "container" : "http");
  return {
    ...app,
    image_ref: candidate.image_ref || "",
    container_port: candidate.container_port,
    environment_id: candidate.environment_id !== undefined ? candidate.environment_id : app.environment_id,
    env_projection: candidate.env_projection == null ? null : JSON.stringify(candidate.env_projection),
    memory_mb: candidate.memory_mb ?? 0,
    cpu_limit: candidate.cpu_limit ?? 0,
    health_check: mode === "http" ? 1 : 0,
    health_check_mode: mode,
    health_check_command: candidate.health_check_command ?? "",
    health_check_file: candidate.health_check_file ?? "",
    health_check_max_age_seconds: candidate.health_check_max_age_seconds ?? 0,
    health_check_expected_statuses: JSON.stringify(candidate.health_check_expected_statuses ?? [200]),
    health_check_path: candidate.health_check_path ?? "",
    internal_protocol: candidate.internal_protocol ?? "http",
    extra_volumes: JSON.stringify((candidate.extra_volumes ?? []).map((v) => `${v.host_path}:${v.container_path}`)),
    command_json: JSON.stringify(candidate.command ?? []),
    cap_add_json: JSON.stringify(candidate.cap_add ?? []),
    post_start_command: candidate.post_start_command ?? "",
    config_revision: app.config_revision + 1,
  };
}

async function candidateEnvVars(app: AppRow, candidate: DeployRequest | null): Promise<Record<string, string>> {
  if (!candidate) return resolveAppEnvVars(app);
  const effectiveApp = candidateApp(app, candidate);
  const environment = effectiveApp.environment_id ? db.getEnvironment(effectiveApp.environment_id) : null;
  const values = await resolveEnvVarsForDeploy(environment?.env_vars);
  if (candidate.env_vars) {
    const incoming = Array.isArray(candidate.env_vars)
      ? candidate.env_vars
      : Object.entries(candidate.env_vars).map(([key, value]) => ({ key, value }));
    for (const entry of incoming) values[entry.key] = entry.value;
  }
  const projected = projectEnvVars(values, candidate.env_projection);
  const platform = platformEnvVars(effectiveApp);
  return { ...platform, ...projected, OCD_DEPLOY_TARGET: platform.OCD_DEPLOY_TARGET };
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
    // If a later compensation already set a
    // concrete running/unhealthy status, don't clobber it with the stale one.
    const app = db.getApp(ctx.input.appId);
    if (app && app.status !== "deploying") return;
    try { db.updateAppStatus(ctx.input.appId, info.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
  },
};

function redeploySnapshotTarget(ctx: { input: RedeployInput; opId: number }) {
  const app = db.getApp(ctx.input.appId);
  if (!app) throw new Error("App not found");
  const first = db.getReplicas(ctx.input.appId)[0];
  if (!first) throw new Error("App has no replicas");
  const server = db.getServer(first.server_id);
  if (!server) throw new Error("Server not found");
  return {
    app,
    first,
    server,
    remote: {
      ip: server.ipv4,
      hostKey: server.ssh_host_key || undefined,
      appName: app.name,
      containerName: first.container_name,
      opId: ctx.opId,
      currentImageRef: app.image_ref,
    },
  };
}

const snapshotCurrentRevision: Step<RedeployInput, RollbackSnapshot | null> = {
  name: "snapshot_current_revision",
  label: "Snapshot current revision",
  async probe(ctx) {
    const target = redeploySnapshotTarget(ctx);
    const remote = await probeRemoteRevisionSnapshot(target.remote);
    if (!remote) return null;
    return {
      remote,
      containerName: target.first.container_name,
      hostPort: target.first.host_port,
      containerPort: target.app.container_port,
      bindAddr: replicaBindHost(target.server),
      volumeMount: target.app.volume_mount || null,
      extraVolumes: db.parseExtraVolumes(target.app.extra_volumes),
      memoryMb: target.app.memory_mb ?? null,
      cpus: target.app.cpu_limit ?? null,
      command: db.parseAppCommand(target.app),
      capAdd: db.parseAppCapabilities(target.app),
      configRevision: target.app.config_revision,
      envHash: hashEnvironment(await resolveAppEnvVars(target.app)),
    };
  },
  async run(ctx) {
    const target = redeploySnapshotTarget(ctx);
    const remote = await captureRemoteRevisionSnapshot(target.remote);
    if (!remote) {
      ctx.log(`No current container found for ${target.app.name}; redeploy will create it without a restore point`);
      return null;
    }
    return {
      remote,
      containerName: target.first.container_name,
      hostPort: target.first.host_port,
      containerPort: target.app.container_port,
      bindAddr: replicaBindHost(target.server),
      volumeMount: target.app.volume_mount || null,
      extraVolumes: db.parseExtraVolumes(target.app.extra_volumes),
      memoryMb: target.app.memory_mb ?? null,
      cpus: target.app.cpu_limit ?? null,
      command: db.parseAppCommand(target.app),
      capAdd: db.parseAppCapabilities(target.app),
      configRevision: target.app.config_revision,
      envHash: hashEnvironment(await resolveAppEnvVars(target.app)),
    };
  },
  async compensate(ctx, snap) {
    if (!snap) return;
    const app = db.getApp(ctx.input.appId);
    const replicas = db.getReplicas(ctx.input.appId);
    const first = replicas[0];
    const server = first ? db.getServer(first.server_id) : null;
    if (!app || !server) return;
    const hostKey = server.ssh_host_key || undefined;
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
      command: snap.command,
      capAdd: snap.capAdd,
      configRevision: snap.configRevision,
      envHash: snap.envHash,
    }, hostKey);
    const health = await probeAppHealth(app, server.ipv4, snap.containerName, snap.bindAddr, snap.hostPort, 5, hostKey);
    if (first) db.updateReplicaStatus(first.id, health.healthy ? "running" : "unhealthy");
    db.updateAppStatus(ctx.input.appId, health.healthy ? "running" : "unhealthy");
    db.appendDeployLog(ctx.input.appId, `[rollback] Restored previous image after failed redeploy (healthy=${health.healthy})`);
    ctx.log(`Rolled back to previous image ${snap.remote.image} (healthy=${health.healthy})`);
    if (!health.healthy && !health.inconclusive) {
      throw new Error(`Rollback restored the previous container for ${app.name} but it is unhealthy`);
    }
    try {
      await discardRemoteRevisionSnapshot(redeploySnapshotTarget(ctx).remote);
    } catch (err) {
      ctx.log(`Failed to discard compensated revision snapshot: ${err}`);
    }
  },
};

const pullAndRunCandidate: Step<RedeployInput, ArtifactOut> = {
  name: "pull_and_run_candidate",
  label: "Pull immutable image",
  async run(ctx) {
    const { appId } = ctx.input;
    const storedApp = db.getApp(appId);
    if (!storedApp) throw new Error("App not found");
    const candidate = effectiveCandidate(storedApp, ctx.input);
    const app = candidateApp(storedApp, candidate);
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const server = db.getServer(first.server_id);
    if (!server) throw new Error("Server not found");

    const containerPort = app.container_port;
    const envVars = await candidateEnvVars(storedApp, candidate);
    const bindAddr = replicaBindHost(server);
    const extraVolumes = db.parseExtraVolumes(app.extra_volumes);
    const imageTag = app.image_ref;

    const runOpts = {
      name: app.name,
      port: containerPort,
      hostPort: first.host_port,
      envVars,
      volumeMount: app.volume_mount || undefined,
      extraVolumes,
      bindAddr,
      containerName: first.container_name,
      memoryMb: app.memory_mb || undefined,
      cpus: app.cpu_limit || undefined,
      command: db.parseAppCommand(app),
      capAdd: db.parseAppCapabilities(app),
      hostKey: server.ssh_host_key || undefined,
      configRevision: app.config_revision,
      envHash: hashEnvironment(envVars),
    };
    const logLine = (line: string) => {
      db.appendDeployLog(appId, `[redeploy] ${line}`);
      ctx.log(`[pull] ${line}`);
    };

    const r = await pullImmutableImageAndRun(server.ipv4, {
      ...runOpts,
      imageRef: app.image_ref,
    }, logLine);

    return {
      imageTag,
      imageDigest: "imageDigest" in r ? r.imageDigest : undefined,
      imageBytes: "imageBytes" in r ? r.imageBytes : undefined,
    };
  },
};

const validateCandidate: Step<RedeployInput, HealthOut> = {
  name: "validate_candidate",
  label: "Validate candidate",
  async run(ctx) {
    if (!ctx.input.candidate) return { healthy: true };
    const stored = db.getApp(ctx.input.appId);
    if (!stored) throw new Error("App not found");
    const candidate = effectiveCandidate(stored, ctx.input)!;
    const app = candidateApp(stored, candidate);
    const first = db.getReplicas(app.id)[0];
    if (!first) throw new Error("App has no replicas");
    const server = db.getServer(first.server_id);
    if (!server) throw new Error("Server not found");
    const health = await probeAppHealth(
      app,
      server.ipv4,
      first.container_name,
      replicaBindHost(server),
      first.host_port,
      10,
      server.ssh_host_key || undefined,
    );
    if (!health.healthy) {
      throw new Error(`Candidate configuration failed readiness before commit: ${health.error || `HTTP ${health.statusCode ?? "no response"}`}`);
    }
    ctx.log(`candidate passed readiness; stored configuration remains at r${stored.config_revision}`);
    return { healthy: true, statusCode: health.statusCode };
  },
};

const rollExtraReplicas: Step<RedeployInput, { ok: true }> = {
  name: "roll_extra_replicas",
  label: "Roll extra replicas",
  async run(ctx, prior) {
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length <= 1) return { ok: true };
    const stored = db.getApp(ctx.input.appId);
    if (!stored) throw new Error("App not found");
    const candidate = effectiveCandidate(stored, ctx.input);
    const app = candidateApp(stored, candidate);
    const build = prior["pull_and_run_candidate"] as ArtifactOut;
    const envVars = await candidateEnvVars(stored, candidate);
    const rolling = await rollingRedeploy(
      ctx.input.appId,
      (step, detail) => ctx.log(`[${step}] ${detail}`),
      {
        imageDigest: build.imageDigest || build.imageTag,
        envHash: hashEnvironment(envVars),
        configRevision: app.config_revision,
      },
      candidate ? { app, envVars } : undefined,
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

const commitCandidateConfig: Step<RedeployInput, { committed: boolean; configRevision: number }> = {
  name: "commit_candidate_config",
  label: "Commit configuration",
  async run(ctx) {
    if (!ctx.input.candidate) {
      const app = db.getApp(ctx.input.appId);
      return { committed: false, configRevision: app?.config_revision ?? 0 };
    }
    const before = db.getApp(ctx.input.appId);
    if (!before) throw new Error("App not found");
    await applyAppConfig(before.id, ctx.input.candidate, {
      userId: ctx.input.userId,
      log: (line) => ctx.log(`[config] ${line}`),
      allowUnchangedLegacyVolumeIntent: ctx.input.allowUnchangedLegacyVolumeIntent,
    });
    await commitManifestDeliverySource(before.id, ctx.input.candidate.delivery_source);
    const after = db.getApp(before.id);
    if (!after) throw new Error("App disappeared while committing candidate configuration");
    if (after.config_revision !== before.config_revision + 1) {
      throw new Error(`Candidate revision commit was not atomic: expected r${before.config_revision + 1}, got r${after.config_revision}`);
    }
    ctx.log(`configuration committed atomically at r${after.config_revision} after readiness passed`);
    return { committed: true, configRevision: after.config_revision };
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
    const build = prior["pull_and_run_candidate"] as ArtifactOut | undefined;
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
    if (app.post_start_command) {
      const first = replicas[0];
      const server = first ? db.getServer(first.server_id) : null;
      if (!first || !server) throw new Error("Primary replica missing for post-start setup");
      await runAppPostStartCommand(
        server.ipv4,
        first.container_name,
        app.post_start_command,
        server.ssh_host_key || undefined,
      );
      db.appendDeployLog(ctx.input.appId, "[post-start] Setup completed");
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
    const build = prior["pull_and_run_candidate"] as ArtifactOut;
    const gitCommit = ctx.input.gitCommit || "";
    const row = db.insertDeployment({
      operation_id: ctx.opId,
      app_id: ctx.input.appId,
      image_tag: build.imageTag,
      image_digest: build.imageDigest || app.image_ref || "",
      image_size_bytes: build.imageBytes,
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

const discardRevisionSnapshot: Step<RedeployInput, { ok: true }> = {
  name: "discard_revision_snapshot",
  label: "Release recovery snapshot",
  async run(ctx) {
    try {
      const target = redeploySnapshotTarget(ctx);
      await discardRemoteRevisionSnapshot(target.remote);
    } catch (err) {
      // Recovery metadata is harmless after every fallible deployment step has
      // completed. Cleanup must never turn a successful rollout into a rollback.
      ctx.log(`Failed to discard revision snapshot: ${err}`);
    }
    return { ok: true };
  },
};

const redeployOp: OpKindDefinition<RedeployInput> = {
  kind: "redeploy",
  label: "Redeploy app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    wakeIfSleeping,
    snapshotCurrentRevision,
    setDeploying,
    pullAndRunCandidate,
    validateCandidate,
    rollExtraReplicas,
    commitCandidateConfig,
    syncIngressStep,
    healthCheckStep,
    recordDeploymentHistory,
    discardRevisionSnapshot,
  ],
};

registerOp(redeployOp as OpKindDefinition<any>);

export default redeployOp;
export type { RedeployInput };
