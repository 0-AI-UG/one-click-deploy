import * as db from "../../shared/db.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { requireStorageDriver } from "../storage/index.ts";
import { removeBindMount as removeStorageMount } from "./_volumes.ts";
import { registerOp } from "./registry.ts";
import { assertCleanupComplete, softStep } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Detach a volume from an app. This is a pure REMOVAL, so there are no
// compensations — nothing to undo for a detach that partially succeeded.
// Independent host/container cleanup is best-effort, followed by a hard gate
// so an incomplete detach is surfaced for reconciliation rather than reported
// as cleanly done.

type DetachVolumeInput = { appId: number };

type ValidateOut = {
  volumeId: string;
  driverId: string;
  hostMountPath: string;
  serverId: number | null;
  hasServer: boolean;
  extraVolumes: string;
  appName: string;
};

const validate: Step<DetachVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (!app.volume_id) throw new Error("App has no volume attached");
    const reps = db.getReplicas(ctx.input.appId);
    const server = reps[0] ? db.getServer(reps[0].server_id) : null;
    // Tear down the bind mount before the storage driver pulls the device so we don't
    // leave a dangling /mnt/ocd-*-data behind.
    const hostMountPath = app.volume_mount?.split(":")[0] || `/mnt/ocd-${app.name}-data`;
    return {
      volumeId: app.volume_id,
      driverId: app.volume_driver,
      hostMountPath,
      serverId: server?.id ?? null,
      hasServer: !!server,
      extraVolumes: app.extra_volumes,
      appName: app.name,
    };
  },
};

const removeBindMount: Step<DetachVolumeInput, { ok: boolean }> = {
  name: "remove_bind_mount",
  label: "Remove bind mount",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    if (!v.hasServer || v.serverId == null) return { ok: true };
    const r = await softStep(ctx, "remove_bind_mount", async () => {
      await removeStorageMount({
        serverId: v.serverId!,
        driverId: v.driverId,
        volumeId: v.volumeId,
        hostMountPath: v.hostMountPath,
        appId: ctx.input.appId,
      });
    });
    return { ok: r.ok };
  },
};

const detachVolume: Step<DetachVolumeInput, { ok: true }> = {
  name: "detach_volume",
  label: "Detach volume",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const driver = requireStorageDriver(v.driverId);
    const server = v.serverId == null ? undefined : db.getServer(v.serverId) ?? undefined;
    const before = await driver.inspect(v.volumeId, server);
    if (before.attachedServerId != null) await driver.detach(v.volumeId, server);
    if (driver.portable) {
      const after = await driver.inspect(v.volumeId, server);
      if (after.attachedServerId != null) {
        throw new Error(`Storage driver did not confirm that volume ${v.volumeId} was detached`);
      }
    }
    db.retireVolume({
      providerVolumeId: v.volumeId,
      driverId: v.driverId,
      formerResourceType: "app",
      formerResourceId: ctx.input.appId,
      formerResourceName: v.appName,
      reason: `removed from manifest by operation #${ctx.opId}`,
      retentionClass: "user",
    });
    return { ok: true };
  },
};

const clearAppVolume: Step<DetachVolumeInput, { ok: true }> = {
  name: "clear_app_volume",
  label: "Clear volume from app",
  async run(ctx) {
    db.updateAppVolume(ctx.input.appId, "", "");
    return { ok: true };
  },
};

const recreateContainer: Step<DetachVolumeInput, { ok: boolean }> = {
  name: "recreate_container",
  label: "Recreate container without volume",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const r = await softStep(ctx, "recreate_container", async () => {
      const result = await recreateAppContainer(
        ctx.input.appId,
        undefined,
        db.parseExtraVolumes(v.extraVolumes),
      );
      if (!result.ok) throw new Error(result.error || "Failed to recreate container");
    });
    return { ok: r.ok };
  },
};

const assertDetachCleanup: Step<DetachVolumeInput, { ok: true }> = {
  name: "assert_cleanup",
  label: "Verify detach cleanup completed",
  async run(ctx, prior) {
    try {
      assertCleanupComplete(prior, ["remove_bind_mount", "recreate_container"]);
    } catch (err) {
      // Provider and desired DB state may already have advanced. Surface the
      // mismatch for reconciliation instead of claiming a clean detach.
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      throw err;
    }
    return { ok: true };
  },
};

const detachVolumeOp: OpKindDefinition<DetachVolumeInput> = {
  kind: "detach_volume",
  label: "Detach volume",
  resourceKeys: (input) => {
    const volumeId = db.getApp(input.appId)?.volume_id;
    return [`app:${input.appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])];
  },
  steps: [validate, removeBindMount, detachVolume, clearAppVolume, recreateContainer, assertDetachCleanup],
};

registerOp(detachVolumeOp as OpKindDefinition<any>);

export default detachVolumeOp;
export type { DetachVolumeInput };
