import * as db from "../../shared/db.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { requireStorageDriver } from "../storage/index.ts";
import { registerOp } from "./registry.ts";
import { ensureBindMount, removeBindMount, removeBindMountBestEffort } from "./_volumes.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Move a volume through small, durable transitions. The source transitions are
// intentionally ordered so their reverse compensations form a valid restore:
// provider attach -> bind mount -> DB pointer -> container convergence.

type ReattachVolumeInput = {
  volumeId: string;
  fromAppId: number;
  toAppId: number;
  mountPath?: string;
};

type ValidateOut = {
  driverId: string;
  fromServerId: number;
  fromProviderServerId: string;
  fromServerIp: string;
  fromHostKey: string;
  fromHostMountPath: string;
  fromVolumeMount: string;
  fromVolumeAttached: boolean;
  fromExtraVolumes: string;
  toServerId: number;
  toProviderServerId: string;
  toServerIp: string;
  toHostKey: string;
  toHostMountPath: string;
  toVolumeMount: string;
  toExtraVolumes: string;
};

type OkOut = { ok: true };

async function recreateOrThrow(appId: number, mount: string | undefined, extraVolumes: string, message: string) {
  const result = await recreateAppContainer(appId, mount, db.parseExtraVolumes(extraVolumes));
  if (!result.ok) throw new Error(result.error || message);
}

async function attachedServerId(volumeId: string, v: ValidateOut): Promise<string | null> {
  const server = db.getServer(v.fromServerId) ?? db.getServer(v.toServerId);
  if (!server) throw new Error("Server not found");
  return (await requireStorageDriver(v.driverId).inspect(volumeId, server)).attachedServerId;
}

const validate: Step<ReattachVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    if (ctx.input.fromAppId === ctx.input.toAppId) throw new Error("Source and target app must differ");
    const fromApp = db.getApp(ctx.input.fromAppId);
    if (!fromApp) throw new Error("Source app not found");
    if (fromApp.volume_id !== ctx.input.volumeId) {
      throw new Error(`Source app does not own volume ${ctx.input.volumeId}`);
    }
    const toApp = db.getApp(ctx.input.toAppId);
    if (!toApp) throw new Error("Target app not found");
    if (toApp.volume_id) throw new Error("Target app already has a volume");

    const fromReps = db.getReplicas(ctx.input.fromAppId);
    const toReps = db.getReplicas(ctx.input.toAppId);
    const fromServer = fromReps[0] ? db.getServer(fromReps[0].server_id) : null;
    const toServer = toReps[0] ? db.getServer(toReps[0].server_id) : null;
    if (!fromServer || !toServer) throw new Error("Server not found");
    const driver = requireStorageDriver(fromApp.volume_driver);
    if (!driver.supports(fromServer) || !driver.supports(toServer)) {
      throw new Error(`Storage driver ${driver.id} does not support both servers`);
    }
    if (!driver.portable && fromServer.id !== toServer.id) {
      throw new Error(`Storage driver ${driver.id} cannot move volumes between servers`);
    }
    if (driver.portable && fromServer.location !== toServer.location) {
      throw new Error(`Cannot reattach: volume in ${fromServer.location}, target in ${toServer.location}`);
    }

    const containerPath = ctx.input.mountPath || "/data";
    const fromHostMountPath = fromApp.volume_mount?.split(":")[0] || `/mnt/ocd-${fromApp.name}-data`;
    const toHostMountPath = driver.portable ? `/mnt/ocd-${toApp.name}-data` : fromHostMountPath;
    return {
      driverId: driver.id,
      fromServerId: fromServer.id,
      fromProviderServerId: fromServer.provider_id,
      fromServerIp: fromServer.ipv4,
      fromHostKey: fromServer.ssh_host_key || "",
      fromHostMountPath,
      fromVolumeMount: fromApp.volume_mount || `${fromHostMountPath}:${containerPath}`,
      fromVolumeAttached: !!fromApp.volume_attached,
      fromExtraVolumes: fromApp.extra_volumes,
      toServerId: toServer.id,
      toProviderServerId: toServer.provider_id,
      toServerIp: toServer.ipv4,
      toHostKey: toServer.ssh_host_key || "",
      toHostMountPath,
      toVolumeMount: `${toHostMountPath}:${containerPath}`,
      toExtraVolumes: toApp.extra_volumes,
    };
  },
};

const recreateSourceWithoutVolume: Step<ReattachVolumeInput, OkOut> = {
  name: "recreate_source_without_volume",
  label: "Drain source volume",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    try {
      await recreateOrThrow(ctx.input.fromAppId, undefined, v.fromExtraVolumes, "Failed to recreate source container without volume");
    } catch (err) {
      // A failed replacement may already have removed the serving container.
      // This step is not yet durable, so restore its own partial work inline.
      try {
        await recreateOrThrow(ctx.input.fromAppId, v.fromVolumeMount, v.fromExtraVolumes, "Failed to restore source container");
      } catch (restoreErr) {
        throw new Error(`${String(err)}; source restore also failed: ${String(restoreErr)}`);
      }
      throw err;
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    await recreateOrThrow(ctx.input.fromAppId, v.fromVolumeMount, v.fromExtraVolumes, "Failed to restore source container");
  },
};

const clearSourceApp: Step<ReattachVolumeInput, OkOut> = {
  name: "clear_source_app",
  label: "Clear volume from source app",
  async probe(ctx) {
    const app = db.getApp(ctx.input.fromAppId);
    return app && !app.volume_id && !app.volume_mount ? { ok: true } : null;
  },
  async run(ctx) {
    db.updateAppVolume(ctx.input.fromAppId, "", "");
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    db.updateAppVolume(ctx.input.fromAppId, ctx.input.volumeId, v.fromVolumeMount, v.fromVolumeAttached, v.driverId);
  },
  async probeCompensated(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    const app = db.getApp(ctx.input.fromAppId);
    return !!v && app?.volume_id === ctx.input.volumeId && app.volume_mount === v.fromVolumeMount &&
      !!app.volume_attached === v.fromVolumeAttached;
  },
};

const removeSourceBind: Step<ReattachVolumeInput, OkOut> = {
  name: "remove_source_bind_mount",
  label: "Remove source bind mount",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    try {
      await removeBindMount({
        serverId: v.fromServerId,
        driverId: v.driverId,
        volumeId: ctx.input.volumeId,
        hostMountPath: v.fromHostMountPath,
        appId: ctx.input.fromAppId,
      });
    } catch (err) {
      // Removal may have partially changed fstab/mount state.
      await ensureBindMount({
        serverId: v.fromServerId,
        driverId: v.driverId,
        volumeId: ctx.input.volumeId,
        hostMountPath: v.fromHostMountPath,
        appId: ctx.input.fromAppId,
      });
      throw err;
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    await ensureBindMount({
      serverId: v.fromServerId,
      driverId: v.driverId,
      volumeId: ctx.input.volumeId,
      hostMountPath: v.fromHostMountPath,
      appId: ctx.input.fromAppId,
    });
  },
};

const detachSourceProvider: Step<ReattachVolumeInput, OkOut> = {
  name: "detach_source_provider",
  label: "Detach volume from source server",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    if (!requireStorageDriver(v.driverId).portable) return { ok: true };
    return (await attachedServerId(ctx.input.volumeId, v)) == null ? { ok: true } : null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const driver = requireStorageDriver(v.driverId);
    if (!driver.portable) return { ok: true };
    const fromServer = db.getServer(v.fromServerId);
    if (!fromServer) throw new Error("Source server not found");
    const before = await attachedServerId(ctx.input.volumeId, v);
    if (before == null) return { ok: true };
    if (before !== v.fromProviderServerId) {
      throw new Error(`Refusing to detach volume ${ctx.input.volumeId} from unexpected server ${before}`);
    }
    try {
      await driver.detach(ctx.input.volumeId, fromServer);
      const after = await attachedServerId(ctx.input.volumeId, v);
      if (after != null) throw new Error(`Provider did not confirm volume ${ctx.input.volumeId} was detached`);
    } catch (err) {
      // A provider timeout may happen after detach. Since this failing step
      // receives no runner compensation, restore it before surfacing failure.
      if ((await attachedServerId(ctx.input.volumeId, v)) == null) {
        await driver.attach(ctx.input.volumeId, fromServer);
      }
      throw err;
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    const driver = requireStorageDriver(v.driverId);
    if (!driver.portable) return;
    const fromServer = db.getServer(v.fromServerId);
    if (!fromServer) throw new Error("Source server not found");
    const current = await attachedServerId(ctx.input.volumeId, v);
    if (current === v.fromProviderServerId) return;
    if (current != null) throw new Error(`Volume ${ctx.input.volumeId} is attached to unexpected server ${current}`);
    await driver.attach(ctx.input.volumeId, fromServer);
    if ((await attachedServerId(ctx.input.volumeId, v)) !== v.fromProviderServerId) {
      throw new Error(`Provider did not confirm volume ${ctx.input.volumeId} was restored to source`);
    }
  },
  async probeCompensated(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    return !!v && (!requireStorageDriver(v.driverId).portable ||
      (await attachedServerId(ctx.input.volumeId, v)) === v.fromProviderServerId);
  },
};

const attachTargetProvider: Step<ReattachVolumeInput, OkOut> = {
  name: "attach_target_provider",
  label: "Attach volume to target server",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    if (!requireStorageDriver(v.driverId).portable) return { ok: true };
    return (await attachedServerId(ctx.input.volumeId, v)) === v.toProviderServerId ? { ok: true } : null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const driver = requireStorageDriver(v.driverId);
    if (!driver.portable) return { ok: true };
    const toServer = db.getServer(v.toServerId);
    if (!toServer) throw new Error("Target server not found");
    const before = await attachedServerId(ctx.input.volumeId, v);
    if (before === v.toProviderServerId) return { ok: true };
    if (before != null) throw new Error(`Volume ${ctx.input.volumeId} is still attached to server ${before}`);
    try {
      await driver.attach(ctx.input.volumeId, toServer);
      if ((await attachedServerId(ctx.input.volumeId, v)) !== v.toProviderServerId) {
        throw new Error(`Provider did not confirm volume ${ctx.input.volumeId} was attached to target`);
      }
    } catch (err) {
      if ((await attachedServerId(ctx.input.volumeId, v)) === v.toProviderServerId) {
        await driver.detach(ctx.input.volumeId, toServer);
      }
      throw err;
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    const driver = requireStorageDriver(v.driverId);
    if (!driver.portable) return;
    const toServer = db.getServer(v.toServerId);
    if (!toServer) throw new Error("Target server not found");
    const current = await attachedServerId(ctx.input.volumeId, v);
    if (current == null) return;
    if (current !== v.toProviderServerId) {
      throw new Error(`Refusing to detach volume ${ctx.input.volumeId} from unexpected server ${current}`);
    }
    await driver.detach(ctx.input.volumeId, toServer);
    if ((await attachedServerId(ctx.input.volumeId, v)) != null) {
      throw new Error(`Provider did not confirm volume ${ctx.input.volumeId} was detached from target`);
    }
  },
  async probeCompensated(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    return !!v && (!requireStorageDriver(v.driverId).portable || (await attachedServerId(ctx.input.volumeId, v)) == null);
  },
};

const bindTarget: Step<ReattachVolumeInput, OkOut> = {
  name: "bind_target_mount",
  label: "Bind volume on target",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    try {
      await ensureBindMount({
        serverId: v.toServerId,
        driverId: v.driverId,
        volumeId: ctx.input.volumeId,
        hostMountPath: v.toHostMountPath,
        appId: ctx.input.toAppId,
      });
    } catch (err) {
      await removeBindMountBestEffort({
        serverId: v.toServerId,
        driverId: v.driverId,
        volumeId: ctx.input.volumeId,
        hostMountPath: v.toHostMountPath,
        appId: ctx.input.toAppId,
      });
      throw err;
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    await removeBindMount({
      serverId: v.toServerId,
      driverId: v.driverId,
      volumeId: ctx.input.volumeId,
      hostMountPath: v.toHostMountPath,
      appId: ctx.input.toAppId,
    });
  },
};

const recordTargetApp: Step<ReattachVolumeInput, OkOut> = {
  name: "record_target_app",
  label: "Record volume on target app",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.toAppId);
    return app?.volume_id === ctx.input.volumeId && app.volume_mount === v.toVolumeMount &&
      !!app.volume_attached === v.fromVolumeAttached ? { ok: true } : null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    db.updateAppVolume(ctx.input.toAppId, ctx.input.volumeId, v.toVolumeMount, v.fromVolumeAttached, v.driverId);
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    db.updateAppVolume(ctx.input.toAppId, "", "");
    // The target replacement can fail after removing the old container. This
    // completed DB step therefore owns convergence back to the volume-less
    // target state, and deliberately has no probeCompensated.
    await recreateOrThrow(ctx.input.toAppId, undefined, v.toExtraVolumes, "Failed to restore target container without volume");
  },
};

// No probe: provider + DB state cannot prove what mounts the live container
// received. Re-run the idempotent recreate after every ambiguous crash.
const recreateTarget: Step<ReattachVolumeInput, OkOut> = {
  name: "recreate_target_with_volume",
  label: "Recreate target container with volume",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    await recreateOrThrow(ctx.input.toAppId, v.toVolumeMount, v.toExtraVolumes, "Failed to recreate target container with volume");
    return { ok: true };
  },
};

const reattachVolumeOp: OpKindDefinition<ReattachVolumeInput> = {
  kind: "reattach_volume",
  label: "Reattach volume",
  resourceKeys: (input) => [
    `app:${input.fromAppId}`,
    `app:${input.toAppId}`,
    `volume:${input.volumeId}`,
  ],
  steps: [
    validate,
    recreateSourceWithoutVolume,
    clearSourceApp,
    removeSourceBind,
    detachSourceProvider,
    attachTargetProvider,
    bindTarget,
    recordTargetApp,
    recreateTarget,
  ],
};

registerOp(reattachVolumeOp as OpKindDefinition<any>);

export default reattachVolumeOp;
export type { ReattachVolumeInput };
