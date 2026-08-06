import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { registerOp } from "./registry.ts";
import {
  loadSingleReplicaTarget,
  ensureBindMount,
  removeBindMountBestEffort,
  type SingleReplicaTarget,
} from "./_volumes.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Attach an EXISTING Hetzner volume to the app's single replica. Same shape as
// attach_volume, but the volume step ATTACHES rather than creates (so its
// compensation DETACHES rather than deletes — we never destroy a pre-existing
// volume). The location precheck lives in validation.

type AttachExistingVolumeInput = { appId: number; volumeId: string; mountPath?: string };

type ValidateOut = SingleReplicaTarget;
type AttachToAppOut = { priorMinReplicas: number; priorMaxReplicas: number; volumeMount: string };

function hostMountPathFor(volumeId: string): string {
  return `/mnt/vol-${volumeId}`;
}

const validate: Step<AttachExistingVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    const target = loadSingleReplicaTarget(ctx.input.appId, { requireNoVolume: true });
    const volInfo = await hetzner.volumes.get(ctx.input.volumeId);
    if (volInfo.location && volInfo.location !== target.serverLocation) {
      throw new Error(
        `Cannot attach: volume is in ${volInfo.location} but server is in ${target.serverLocation}`,
      );
    }
    return target;
  },
};

const attachVolume: Step<AttachExistingVolumeInput, { hostMountPath: string }> = {
  name: "attach_volume",
  label: "Attach volume to server",
  async probe(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    try {
      const info = await hetzner.volumes.get(ctx.input.volumeId);
      if (info.serverId === target.providerServerId) {
        ctx.log(`volume ${ctx.input.volumeId} already attached to server ${target.providerServerId}`);
        return { hostMountPath: hostMountPathFor(ctx.input.volumeId) };
      }
    } catch { /* fall through to run */ }
    return null;
  },
  async run(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    await hetzner.volumes.attach(ctx.input.volumeId, target.providerServerId);
    return { hostMountPath: hostMountPathFor(ctx.input.volumeId) };
  },
  async compensate(ctx) {
    // probeCompensated already short-circuits when the volume is no longer on
    // the target server, so if we reach here the volume really is still
    // attached and must come off. Do NOT swallow a detach failure: leaving a
    // pre-existing volume stranded on the wrong server behind a clean
    // `compensated` is a silent inconsistency — let it propagate to
    // `compensation_failed` instead.
    await hetzner.volumes.detach(ctx.input.volumeId);
    ctx.log(`Detached volume ${ctx.input.volumeId}`);
  },
  async probeCompensated(ctx, _out, prior) {
    const target = prior["validate"] as ValidateOut | undefined;
    try {
      const info = await hetzner.volumes.get(ctx.input.volumeId);
      return info.serverId !== (target?.providerServerId ?? null);
    } catch {
      return false;
    }
  },
};

const bindMount: Step<AttachExistingVolumeInput, { ok: true }> = {
  name: "bind_mount",
  label: "Bind volume mount",
  async run(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    await ensureBindMount({
      serverIp: target.serverIp,
      hostKey: target.hostKey,
      volumeId: ctx.input.volumeId,
      hostMountPath: hostMountPathFor(ctx.input.volumeId),
      appId: ctx.input.appId,
    });
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const target = prior["validate"] as ValidateOut | undefined;
    if (!target) return;
    await removeBindMountBestEffort({
      serverIp: target.serverIp,
      hostKey: target.hostKey,
      hostMountPath: hostMountPathFor(ctx.input.volumeId),
      appId: ctx.input.appId,
    });
  },
};

const attachToApp: Step<AttachExistingVolumeInput, AttachToAppOut> = {
  name: "attach_to_app",
  label: "Record volume on app",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const containerPath = ctx.input.mountPath || "/data";
    const volumeMount = `${hostMountPathFor(ctx.input.volumeId)}:${containerPath}`;
    const priorMinReplicas = app.min_replicas;
    const priorMaxReplicas = app.max_replicas;
    // attached=true: this is a pre-existing volume, so destroy must DETACH it,
    // never delete it (deleting would be data loss on a volume we don't own).
    db.updateAppVolume(ctx.input.appId, ctx.input.volumeId, volumeMount, true);
    // A volume locks the app to a single server: force min/max replicas to 1.
    db.updateAppScaling(ctx.input.appId, { min_replicas: Math.min(1, app.min_replicas), max_replicas: 1 });
    return { priorMinReplicas, priorMaxReplicas, volumeMount };
  },
  async compensate(ctx, out) {
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
    // container behind a clean `compensated` is the silent-rollback bug. Let it
    // propagate so a dead app surfaces as `compensation_failed`.
    // recreateAppContainer is idempotent, so re-running the compensate is safe.
    const result = await recreateAppContainer(ctx.input.appId, undefined, db.parseExtraVolumes(app.extra_volumes));
    if (!result.ok) throw new Error(result.error || "Failed to recreate volume-less container during rollback");
  },
};

const recreateContainer: Step<AttachExistingVolumeInput, { ok: true }> = {
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

const attachExistingVolumeOp: OpKindDefinition<AttachExistingVolumeInput> = {
  kind: "attach_existing_volume",
  label: "Attach existing volume",
  resourceKeys: (input) => [`app:${input.appId}`, `volume:${input.volumeId}`],
  steps: [validate, attachVolume, bindMount, attachToApp, recreateContainer],
};

registerOp(attachExistingVolumeOp as OpKindDefinition<any>);

export default attachExistingVolumeOp;
export type { AttachExistingVolumeInput };
