import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { registerOp } from "./registry.ts";
import {
  loadSingleReplicaTarget,
  ensureBindMount,
  removeBindMountBestEffort,
  type SingleReplicaTarget,
} from "./_volumes.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Create a brand-new Hetzner volume and attach it to the app's single replica.
// Every step past validation has a compensation, so any failure — including a
// failed container recreate — rolls the whole thing back: the DB volume is
// cleared, the scaling floor is restored, the bind mount is removed and the
// cloud volume is detached + deleted.

type AttachVolumeInput = { appId: number; sizeGb: number; mountPath?: string };

type CreateVolumeOut = { volumeId: string; hostMountPath: string; volName: string };
type AttachToAppOut = { priorMinReplicas: number; priorMaxReplicas: number; volumeMount: string };

const validate: Step<AttachVolumeInput, SingleReplicaTarget> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    return loadSingleReplicaTarget(ctx.input.appId, { requireNoVolume: true });
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
    const target = prior["validate"] as SingleReplicaTarget;
    const volName = volumeName(target, ctx.opId);
    let all;
    try {
      all = await hetzner.volumes.list();
    } catch {
      return null;
    }
    const existing = all.find((v) => v.name === volName);
    if (!existing) return null;
    const retired = db.getRetiredVolumes().find(
      (row) => row.provider_volume_id === existing.providerId,
    );
    if (retired) {
      throw new Error(
        `Refusing to adopt retained volume ${existing.providerId} (${volName}); ` +
        `it belongs to ${retired.former_resource_type}:${retired.former_resource_name}. ` +
        "Attach it explicitly as an existing volume or permanently delete it first.",
      );
    }
    if (
      existing.sizeGb !== ctx.input.sizeGb ||
      existing.location !== target.serverLocation ||
      (existing.serverId != null && existing.serverId !== target.providerServerId)
    ) {
      throw new Error(
        `Volume name collision for ${volName}: provider volume ${existing.providerId} ` +
        `does not match the requested size/location/server. Refusing implicit adoption.`,
      );
    }
    ctx.log(`adopting existing volume ${existing.providerId} (${volName})`);
    return { volumeId: existing.providerId, hostMountPath: `/mnt/${volName}`, volName };
  },
  async run(ctx, prior) {
    const target = prior["validate"] as SingleReplicaTarget;
    const volName = volumeName(target, ctx.opId);
    const vol = await hetzner.volumes.create({
      name: volName,
      sizeGb: ctx.input.sizeGb,
      serverId: target.providerServerId,
      location: target.serverLocation,
    });
    ctx.log(`Created volume ${vol.providerId} (${volName}, ${ctx.input.sizeGb}GB)`);
    return { volumeId: vol.providerId, hostMountPath: `/mnt/${volName}`, volName };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try { await hetzner.volumes.detach(out.volumeId); } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    const app = db.getApp(ctx.input.appId);
    db.retireVolume({
      providerVolumeId: out.volumeId,
      formerResourceType: "app",
      formerResourceId: ctx.input.appId,
      formerResourceName: app?.name ?? `app-${ctx.input.appId}`,
      reason: `attach-volume operation #${ctx.opId} compensated`,
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
      serverIp: target.serverIp,
      hostKey: target.hostKey,
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
      serverIp: target.serverIp,
      hostKey: target.hostKey,
      hostMountPath: vol.hostMountPath,
      appId: ctx.input.appId,
    });
  },
};

const attachToApp: Step<AttachVolumeInput, AttachToAppOut> = {
  name: "attach_to_app",
  label: "Record volume on app",
  async run(ctx, prior) {
    const vol = prior["create_volume"] as CreateVolumeOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const containerPath = ctx.input.mountPath || "/data";
    const volumeMount = `${vol.hostMountPath}:${containerPath}`;
    const priorMinReplicas = app.min_replicas;
    const priorMaxReplicas = app.max_replicas;
    db.updateAppVolume(ctx.input.appId, vol.volumeId, volumeMount);
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
