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
    try {
      const all = await hetzner.volumes.list();
      const existing = all.find((v) => v.name === volName);
      if (!existing) return null;
      ctx.log(`adopting existing volume ${existing.providerId} (${volName})`);
      return { volumeId: existing.providerId, hostMountPath: `/mnt/${volName}`, volName };
    } catch {
      return null;
    }
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
    // Detach is best-effort: the volume may already be detached (or never
    // reached the attach), and a benign "already detached" here must not mask
    // the delete below.
    try { await hetzner.volumes.detach(out.volumeId); } catch { /* already detached */ }
    // Do NOT swallow a delete failure: leaving the just-created cloud volume
    // behind a clean `compensated` status is a silent leak. Delete is
    // idempotent (an already-gone volume is success); any other failure
    // propagates so the op ends `compensation_failed`.
    try {
      await hetzner.volumes.delete(out.volumeId);
      ctx.log(`Deleted volume ${out.volumeId}`);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    try {
      await hetzner.volumes.get(out.volumeId);
      return false;
    } catch (err) {
      // Only a definitive not-found means "already deleted"; a transient error
      // must fall through to run the delete rather than leak the volume.
      return isNotFoundError(err);
    }
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
