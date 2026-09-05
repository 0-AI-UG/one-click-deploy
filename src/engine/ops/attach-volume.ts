import * as db from "../../shared/db.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { defaultStorageDriverForServer, requireStorageDriver } from "../storage/index.ts";
import { registerOp } from "./registry.ts";
import {
  loadSingleReplicaTarget,
  ensureBindMount,
  removeBindMountBestEffort,
  type SingleReplicaTarget,
} from "./_volumes.ts";
import { FatalProbeError, type OpKindDefinition, type Step } from "../types.ts";

// Create a brand-new volume and attach it to the app's single replica.
// Every step past validation has a compensation, so any failure — including a
// failed container recreate — rolls the whole thing back: the DB volume is
// cleared, the scaling floor is restored, the bind mount is removed and the
// cloud volume is detached + deleted.

type AttachVolumeInput = { appId: number; sizeGb: number; mountPath?: string; driverId?: string };

type CreateVolumeOut = { volumeId: string; driverId: string; hostMountPath: string; volName: string };
type AttachToAppOut = { priorMinReplicas: number; priorMaxReplicas: number; volumeMount: string };
type ValidateOut = SingleReplicaTarget & { priorMinReplicas: number; priorMaxReplicas: number; driverId: string };

const validate: Step<AttachVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    const target = loadSingleReplicaTarget(ctx.input.appId, { requireNoVolume: true });
    const app = db.getApp(ctx.input.appId)!;
    const server = db.getServer(target.serverId)!;
    const driver = ctx.input.driverId
      ? requireStorageDriver(ctx.input.driverId)
      : defaultStorageDriverForServer(server);
    if (!driver.supports(server)) {
      throw new Error(`Storage driver ${driver.id} does not support server ${server.name}`);
    }
    return {
      ...target,
      driverId: driver.id,
      priorMinReplicas: app.min_replicas,
      priorMaxReplicas: app.max_replicas,
    };
  },
};

// Deterministic name derived from the op id so replay + probe are stable: a
// crash between create and finishStep re-adopts the same volume instead of
// leaking a second one.
function volumeName(target: SingleReplicaTarget, opId: number): string {
  return `ocd-${target.appName}-op${opId}`;
}

const createVolume: Step<AttachVolumeInput, CreateVolumeOut> = {
  name: "create_volume",
  label: "Create volume",
  async probe(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    const server = db.getServer(target.serverId);
    if (!server) throw new FatalProbeError("Server disappeared while creating volume");
    const driver = requireStorageDriver(target.driverId);
    const volName = volumeName(target, ctx.opId);
    let all;
    try {
      all = await driver.list(server);
    } catch (error) {
      throw new FatalProbeError(
        `Cannot verify whether operation-owned volume ${volName} already exists; refusing to create a possible duplicate`,
        { cause: error },
      );
    }
    const existing = all.find((v) => v.name === volName);
    if (!existing) return null;
    const retired = db.getRetiredVolumes().find(
      (row) => row.provider_volume_id === existing.id && row.driver_id === driver.id,
    );
    if (retired) {
      throw new FatalProbeError(
        `Refusing to adopt retained volume ${existing.id} (${volName}); ` +
        `it belongs to ${retired.former_resource_type}:${retired.former_resource_name}. ` +
        "Attach it explicitly as an existing volume or permanently delete it first.",
      );
    }
    if (
      existing.sizeGb !== ctx.input.sizeGb ||
      (driver.portable && existing.location !== target.serverLocation) ||
      (existing.attachedServerId != null &&
        existing.attachedServerId !== target.providerServerId &&
        existing.attachedServerId !== String(target.serverId))
    ) {
      throw new FatalProbeError(
        `Volume name collision for ${volName}: storage volume ${existing.id} ` +
        `does not match the requested size/location/server. Refusing implicit adoption.`,
      );
    }
    ctx.log(`adopting existing volume ${existing.id} (${volName})`);
    return { volumeId: existing.id, driverId: driver.id, hostMountPath: existing.hostPath, volName };
  },
  async run(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const driver = requireStorageDriver(target.driverId);
    const volName = volumeName(target, ctx.opId);
    const vol = await driver.create({
      server,
      name: volName,
      sizeGb: ctx.input.sizeGb,
    });
    ctx.log(`Created volume ${vol.id} with ${driver.id} (${volName}, ${ctx.input.sizeGb}GB)`);
    return { volumeId: vol.id, driverId: driver.id, hostMountPath: vol.hostPath, volName };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const target = prior["validate"] as ValidateOut | undefined;
    const server = target ? db.getServer(target.serverId) ?? undefined : undefined;
    const driver = requireStorageDriver(out.driverId);
    try { await driver.detach(out.volumeId, server); } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    const app = db.getApp(ctx.input.appId);
    db.retireVolume({
      providerVolumeId: out.volumeId,
      driverId: out.driverId,
      formerResourceType: "app",
      formerResourceId: ctx.input.appId,
      formerResourceName: app?.name ?? `app-${ctx.input.appId}`,
      reason: `attach-volume operation #${ctx.opId} compensated`,
      retentionClass: "provisional",
    });
    ctx.log(`Retained detached volume ${out.volumeId} for recovery`);
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    return db.getRetiredVolumes().some((row) => row.provider_volume_id === out.volumeId);
  },
};

const bindMount: Step<AttachVolumeInput, { ok: true }> = {
  name: "bind_mount",
  label: "Bind volume mount",
  async run(ctx, prior) {
    const target = prior["validate"] as SingleReplicaTarget;
    const vol = prior["create_volume"] as CreateVolumeOut;
    await ensureBindMount({
      serverId: target.serverId,
      driverId: vol.driverId,
      volumeId: vol.volumeId,
      hostMountPath: vol.hostMountPath,
      appId: ctx.input.appId,
    });
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const target = prior["validate"] as SingleReplicaTarget | undefined;
    const vol = prior["create_volume"] as CreateVolumeOut | undefined;
    if (!target || !vol) return;
    await removeBindMountBestEffort({
      serverId: target.serverId,
      driverId: vol.driverId,
      volumeId: vol.volumeId,
      hostMountPath: vol.hostMountPath,
      appId: ctx.input.appId,
    });
  },
};

const attachToApp: Step<AttachVolumeInput, AttachToAppOut> = {
  name: "attach_to_app",
  label: "Record volume on app",
  async probe(ctx, prior) {
    const vol = prior["create_volume"] as CreateVolumeOut;
    const before = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new FatalProbeError("App disappeared while recording its volume");
    const volumeMount = `${vol.hostMountPath}:${ctx.input.mountPath || "/data"}`;
    if (app.volume_id && app.volume_id !== vol.volumeId) {
      throw new FatalProbeError(
        `App already references unexpected volume ${app.volume_id}; refusing to overwrite it with ${vol.volumeId}`,
      );
    }
    if (
      app.volume_id === vol.volumeId &&
      app.volume_mount === volumeMount &&
      app.max_replicas === 1 &&
      app.min_replicas === Math.min(1, before.priorMinReplicas)
    ) {
      return {
        priorMinReplicas: before.priorMinReplicas,
        priorMaxReplicas: before.priorMaxReplicas,
        volumeMount,
      };
    }
    return null;
  },
  async run(ctx, prior) {
    const vol = prior["create_volume"] as CreateVolumeOut;
    const before = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const containerPath = ctx.input.mountPath || "/data";
    const volumeMount = `${vol.hostMountPath}:${containerPath}`;
    const priorMinReplicas = before?.priorMinReplicas ?? app.min_replicas;
    const priorMaxReplicas = before?.priorMaxReplicas ?? app.max_replicas;
    db.updateAppVolume(ctx.input.appId, vol.volumeId, volumeMount, false, vol.driverId);
    // A volume locks the app to a single server: force min/max replicas to 1
    // so autoscale + manual scaling cannot ever bring up replica 2+.
    db.updateAppScaling(ctx.input.appId, { min_replicas: Math.min(1, app.min_replicas), max_replicas: 1 });
    return { priorMinReplicas, priorMaxReplicas, volumeMount };
  },
  async compensate(ctx, out) {
    // Clear the volume + restore the prior scaling floor, then recreate the
    // container without the volume so the app returns to its pre-op running
    // state (the cloud volume is deleted by create_volume's compensate, which
    // runs after this one).
    try { db.updateAppVolume(ctx.input.appId, "", ""); } catch (err) { ctx.log(`clear volume failed: ${err}`); }
    if (out) {
      try {
        db.updateAppScaling(ctx.input.appId, {
          min_replicas: out.priorMinReplicas,
          max_replicas: out.priorMaxReplicas,
        });
      } catch (err) { ctx.log(`restore scaling failed: ${err}`); }
    }
    const app = db.getApp(ctx.input.appId);
    if (!app) return;
    // Do NOT swallow a failed recreate: leaving the app with no serving
    // container behind a clean `compensated` is the silent-rollback bug we're
    // fixing. Let it propagate so a dead app surfaces as `compensation_failed`
    // (reconciler retries, operators see it). recreateAppContainer is
    // idempotent, so re-running the compensate is safe.
    const result = await recreateAppContainer(ctx.input.appId, undefined, db.parseExtraVolumes(app.extra_volumes));
    if (!result.ok) throw new Error(result.error || "Failed to recreate volume-less container during rollback");
  },
};

const recreateContainer: Step<AttachVolumeInput, { ok: true }> = {
  name: "recreate_container",
  label: "Recreate container with volume",
  async run(ctx, prior) {
    const att = prior["attach_to_app"] as AttachToAppOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const result = await recreateAppContainer(
      ctx.input.appId,
      att.volumeMount,
      db.parseExtraVolumes(app.extra_volumes),
    );
    if (!result.ok) throw new Error(result.error || "Failed to recreate container");
    return { ok: true };
  },
};

const attachVolumeOp: OpKindDefinition<AttachVolumeInput> = {
  kind: "attach_volume",
  label: "Attach volume",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [validate, createVolume, bindMount, attachToApp, recreateContainer],
};

registerOp(attachVolumeOp as OpKindDefinition<any>);

export default attachVolumeOp;
export type { AttachVolumeInput };
