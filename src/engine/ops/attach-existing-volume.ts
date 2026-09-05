import * as db from "../../shared/db.ts";
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

// Attach an existing storage volume to the app's single replica. Same shape as
// attach_volume, but the volume step ATTACHES rather than creates (so its
// compensation DETACHES rather than deletes — we never destroy a pre-existing
// volume). The location precheck lives in validation.

type AttachExistingVolumeInput = { appId: number; volumeId: string; mountPath?: string; driverId?: string };

type ValidateOut = SingleReplicaTarget & {
  priorMinReplicas: number;
  priorMaxReplicas: number;
  driverId: string;
  hostMountPath: string;
};
type AttachToAppOut = { priorMinReplicas: number; priorMaxReplicas: number; volumeMount: string };

const validate: Step<AttachExistingVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    const target = loadSingleReplicaTarget(ctx.input.appId, { requireNoVolume: true });
    const app = db.getApp(ctx.input.appId)!;
    const server = db.getServer(target.serverId)!;
    const retired = db.getRetiredVolumes().find((v) => v.provider_volume_id === ctx.input.volumeId);
    const driver = requireStorageDriver(
      ctx.input.driverId || retired?.driver_id || defaultStorageDriverForServer(server).id,
    );
    if (!driver.supports(server)) throw new Error(`Storage driver ${driver.id} does not support server ${server.name}`);
    const volInfo = await driver.inspect(ctx.input.volumeId, server);
    if (driver.portable && volInfo.location && volInfo.location !== target.serverLocation) {
      throw new Error(
        `Cannot attach: volume is in ${volInfo.location} but server is in ${target.serverLocation}`,
      );
    }
    return {
      ...target,
      driverId: driver.id,
      hostMountPath: volInfo.hostPath,
      priorMinReplicas: app.min_replicas,
      priorMaxReplicas: app.max_replicas,
    };
  },
};

const attachVolume: Step<AttachExistingVolumeInput, { hostMountPath: string }> = {
  name: "attach_volume",
  label: "Attach volume to server",
  async probe(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    const server = db.getServer(target.serverId);
    if (!server) throw new FatalProbeError("Server disappeared while attaching volume");
    const driver = requireStorageDriver(target.driverId);
    try {
      const info = await driver.inspect(ctx.input.volumeId, server);
      if (info.attachedServerId === target.providerServerId || info.attachedServerId === String(target.serverId)) {
        ctx.log(`volume ${ctx.input.volumeId} already attached to server ${target.providerServerId}`);
        return { hostMountPath: target.hostMountPath };
      }
      if (info.attachedServerId != null) {
        throw new FatalProbeError(
          `Volume ${ctx.input.volumeId} is attached to unexpected server ${info.attachedServerId}; refusing to move it implicitly`,
        );
      }
    } catch (error) {
      if (error instanceof FatalProbeError) throw error;
      throw new FatalProbeError(
        `Cannot verify attachment state for volume ${ctx.input.volumeId}; refusing an unsafe attach`,
        { cause: error },
      );
    }
    return null;
  },
  async run(ctx, prior) {
    const target = prior["validate"] as ValidateOut;
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const driver = requireStorageDriver(target.driverId);
    try {
      await driver.attach(ctx.input.volumeId, server);
      const confirmed = await driver.inspect(ctx.input.volumeId, server);
      if (confirmed.attachedServerId !== target.providerServerId && confirmed.attachedServerId !== String(target.serverId)) {
        throw new Error(
          `Provider did not confirm volume ${ctx.input.volumeId} on server ${target.providerServerId}`,
        );
      }
    } catch (error) {
      // A failing step is not part of the runner's reverse walk. Restore the
      // pre-step detached state inline if attach may have succeeded before a
      // failed confirmation request.
      try {
        const state = await driver.inspect(ctx.input.volumeId, server);
        if (state.attachedServerId === target.providerServerId || state.attachedServerId === String(target.serverId)) {
          await driver.detach(ctx.input.volumeId, server);
        }
      } catch (rollbackError) {
        throw new Error(
          `Volume attach failed and its inline rollback could not be verified: ${rollbackError}`,
          { cause: error },
        );
      }
      throw error;
    }
    return { hostMountPath: target.hostMountPath };
  },
  async compensate(ctx, _out, prior) {
    // probeCompensated already short-circuits when the volume is no longer on
    // the target server, so if we reach here the volume really is still
    // attached and must come off. Do NOT swallow a detach failure: leaving a
    // pre-existing volume stranded on the wrong server behind a clean
    // `compensated` is a silent inconsistency — let it propagate to
    // `compensation_failed` instead.
    const target = prior["validate"] as ValidateOut;
    const server = db.getServer(target.serverId);
    await requireStorageDriver(target.driverId).detach(ctx.input.volumeId, server ?? undefined);
    ctx.log(`Detached volume ${ctx.input.volumeId}`);
  },
  async probeCompensated(ctx, _out, prior) {
    const target = prior["validate"] as ValidateOut | undefined;
    if (!target) return false;
    const server = db.getServer(target.serverId);
    if (!server) return false;
    try {
      const info = await requireStorageDriver(target.driverId).inspect(ctx.input.volumeId, server);
      return info.attachedServerId !== target.providerServerId && info.attachedServerId !== String(target.serverId);
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
      serverId: target.serverId,
      driverId: target.driverId,
      volumeId: ctx.input.volumeId,
      hostMountPath: target.hostMountPath,
      appId: ctx.input.appId,
    });
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const target = prior["validate"] as ValidateOut | undefined;
    if (!target) return;
    await removeBindMountBestEffort({
      serverId: target.serverId,
      driverId: target.driverId,
      volumeId: ctx.input.volumeId,
      hostMountPath: target.hostMountPath,
      appId: ctx.input.appId,
    });
  },
};

const attachToApp: Step<AttachExistingVolumeInput, AttachToAppOut> = {
  name: "attach_to_app",
  label: "Record volume on app",
  async probe(ctx, prior) {
    const before = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new FatalProbeError("App disappeared while recording its volume");
    const volumeMount = `${before.hostMountPath}:${ctx.input.mountPath || "/data"}`;
    if (app.volume_id && app.volume_id !== ctx.input.volumeId) {
      throw new FatalProbeError(
        `App already references unexpected volume ${app.volume_id}; refusing to overwrite it with ${ctx.input.volumeId}`,
      );
    }
    if (
      app.volume_id === ctx.input.volumeId &&
      app.volume_mount === volumeMount &&
      app.volume_attached === 1 &&
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
    const before = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const containerPath = ctx.input.mountPath || "/data";
    const volumeMount = `${before.hostMountPath}:${containerPath}`;
    const priorMinReplicas = before?.priorMinReplicas ?? app.min_replicas;
    const priorMaxReplicas = before?.priorMaxReplicas ?? app.max_replicas;
    // attached=true: this is a pre-existing volume, so destroy must DETACH it,
    // never delete it (deleting would be data loss on a volume we don't own).
    db.updateAppVolume(ctx.input.appId, ctx.input.volumeId, volumeMount, true, before.driverId);
    db.deleteRetiredVolume(ctx.input.volumeId);
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
