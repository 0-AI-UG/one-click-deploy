import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { registerOp } from "./registry.ts";
import { ensureBindMount, removeBindMountBestEffort } from "./_volumes.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Move a volume from a source app to a target app. This one needs REAL
// compensation because it detaches from the source before attaching to the
// target: if the target attach fails, the volume must roll back to the source
// and both apps must end consistent.
//
// - detach_from_source: detaches + clears the source; its compensate RE-ATTACHES
//   to the source (attach + bind + db + recreate).
// - attach_to_target: attaches + binds + records + recreates on the target. It
//   cleans up its OWN partial work inline on failure (the step-runner never
//   calls a failing step's compensate), so the source re-attach can succeed.
//
// Both steps carry probe/probeCompensated so a crash mid-way resumes idempotently.

type ReattachVolumeInput = {
  volumeId: string;
  fromAppId: number;
  toAppId: number;
  mountPath?: string;
};

type ValidateOut = {
  fromProviderServerId: string;
  fromServerIp: string;
  fromHostKey: string;
  fromHostMountPath: string;
  fromVolumeMount: string;
  fromVolumeAttached: boolean;
  fromExtraVolumes: string;
  toProviderServerId: string;
  toServerIp: string;
  toHostKey: string;
  toHostMountPath: string;
  toVolumeMount: string;
  toExtraVolumes: string;
};

const validate: Step<ReattachVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate preconditions",
  async run(ctx) {
    const fromApp = db.getApp(ctx.input.fromAppId);
    if (!fromApp) throw new Error("Source app not found");
    const toApp = db.getApp(ctx.input.toAppId);
    if (!toApp) throw new Error("Target app not found");
    if (toApp.volume_id) throw new Error("Target app already has a volume");

    const fromReps = db.getReplicas(ctx.input.fromAppId);
    const toReps = db.getReplicas(ctx.input.toAppId);
    const fromServer = fromReps[0] ? db.getServer(fromReps[0].server_id) : null;
    const toServer = toReps[0] ? db.getServer(toReps[0].server_id) : null;
    if (!fromServer || !toServer) throw new Error("Server not found");
    if (fromServer.location !== toServer.location) {
      throw new Error(`Cannot reattach: volume in ${fromServer.location}, target in ${toServer.location}`);
    }

    const containerPath = ctx.input.mountPath || "/data";
    const toHostMountPath = `/mnt/ocd-${toApp.name}-data`;
    const fromHostMountPath = fromApp.volume_mount?.split(":")[0] || `/mnt/ocd-${fromApp.name}-data`;
    return {
      fromProviderServerId: fromServer.provider_id,
      fromServerIp: fromServer.ipv4,
      fromHostKey: fromServer.ssh_host_key || "",
      fromHostMountPath,
      fromVolumeMount: fromApp.volume_mount || `${fromHostMountPath}:${containerPath}`,
      // Carry the source volume's provenance so a created/attached-existing
      // volume keeps the same destroy semantics after the move.
      fromVolumeAttached: !!fromApp.volume_attached,
      fromExtraVolumes: fromApp.extra_volumes,
      toProviderServerId: toServer.provider_id,
      toServerIp: toServer.ipv4,
      toHostKey: toServer.ssh_host_key || "",
      toHostMountPath,
      toVolumeMount: `${toHostMountPath}:${containerPath}`,
      toExtraVolumes: toApp.extra_volumes,
    };
  },
};

const detachFromSource: Step<ReattachVolumeInput, { ok: true }> = {
  name: "detach_from_source",
  label: "Detach volume from source",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    try {
      const info = await hetzner.volumes.get(ctx.input.volumeId);
      const fromApp = db.getApp(ctx.input.fromAppId);
      if (info.serverId !== v.fromProviderServerId && fromApp && !fromApp.volume_id) {
        ctx.log(`source already detached (volume ${ctx.input.volumeId})`);
        return { ok: true };
      }
    } catch { /* fall through to run */ }
    return null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    await removeBindMountBestEffort({
      serverIp: v.fromServerIp,
      hostKey: v.fromHostKey,
      hostMountPath: v.fromHostMountPath,
      appId: ctx.input.fromAppId,
    });
    await hetzner.volumes.detach(ctx.input.volumeId);
    db.updateAppVolume(ctx.input.fromAppId, "", "");
    await recreateAppContainer(ctx.input.fromAppId, undefined, db.parseExtraVolumes(v.fromExtraVolumes));
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    // Roll the volume back onto the source app. Do NOT swallow failures here:
    // this is a RESTORE — if the volume can't be re-attached, or the source
    // container can't be brought back, the source app is left broken with its
    // volume stranded on the target. That must surface as `compensation_failed`
    // (reconciler retries, operators see it), not be hidden behind a clean
    // `compensated` under a "MANUAL RECOVERY NEEDED" log line. probeCompensated
    // short-circuits this step once the volume is back on source, so re-running
    // after a partial restore is safe/idempotent.
    await hetzner.volumes.attach(ctx.input.volumeId, v.fromProviderServerId);
    await ensureBindMount({
      serverIp: v.fromServerIp,
      hostKey: v.fromHostKey,
      volumeId: ctx.input.volumeId,
      hostMountPath: v.fromHostMountPath,
      appId: ctx.input.fromAppId,
    });
    db.updateAppVolume(ctx.input.fromAppId, ctx.input.volumeId, v.fromVolumeMount, v.fromVolumeAttached);
    const result = await recreateAppContainer(ctx.input.fromAppId, v.fromVolumeMount, db.parseExtraVolumes(v.fromExtraVolumes));
    if (!result.ok) throw new Error(result.error || "Failed to recreate source container during reattach rollback");
    ctx.log(`Re-attached volume ${ctx.input.volumeId} to source app ${ctx.input.fromAppId}`);
  },
  async probeCompensated(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    try {
      const info = await hetzner.volumes.get(ctx.input.volumeId);
      const fromApp = db.getApp(ctx.input.fromAppId);
      return info.serverId === v?.fromProviderServerId && !!fromApp?.volume_id;
    } catch {
      return false;
    }
  },
};

const attachToTarget: Step<ReattachVolumeInput, { ok: true }> = {
  name: "attach_to_target",
  label: "Attach volume to target",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    try {
      const info = await hetzner.volumes.get(ctx.input.volumeId);
      const toApp = db.getApp(ctx.input.toAppId);
      if (info.serverId === v.toProviderServerId && toApp?.volume_id === ctx.input.volumeId) {
        ctx.log(`volume ${ctx.input.volumeId} already on target app ${ctx.input.toAppId}`);
        return { ok: true };
      }
    } catch { /* fall through to run */ }
    return null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    // The step-runner never calls a failing step's own compensate, so if any
    // part of the target attach fails we must undo our partial target-side work
    // inline before rethrowing — otherwise the detach_from_source compensate
    // can't re-attach the (still target-attached) volume back to the source.
    let attached = false;
    let bound = false;
    let dbSet = false;
    try {
      await hetzner.volumes.attach(ctx.input.volumeId, v.toProviderServerId);
      attached = true;
      await ensureBindMount({
        serverIp: v.toServerIp,
        hostKey: v.toHostKey,
        volumeId: ctx.input.volumeId,
        hostMountPath: v.toHostMountPath,
        appId: ctx.input.toAppId,
      });
      bound = true;
      db.updateAppVolume(ctx.input.toAppId, ctx.input.volumeId, v.toVolumeMount, v.fromVolumeAttached);
      dbSet = true;
      const result = await recreateAppContainer(
        ctx.input.toAppId,
        v.toVolumeMount,
        db.parseExtraVolumes(v.toExtraVolumes),
      );
      if (!result.ok) throw new Error(result.error || "Failed to recreate container");
      return { ok: true };
    } catch (err) {
      ctx.log(`Target attach failed, cleaning up partial work: ${err}`);
      if (dbSet) {
        try { db.updateAppVolume(ctx.input.toAppId, "", ""); } catch { /* best-effort */ }
        try {
          await recreateAppContainer(ctx.input.toAppId, undefined, db.parseExtraVolumes(v.toExtraVolumes));
        } catch { /* best-effort */ }
      }
      if (bound) {
        await removeBindMountBestEffort({
          serverIp: v.toServerIp,
          hostKey: v.toHostKey,
          hostMountPath: v.toHostMountPath,
          appId: ctx.input.toAppId,
        });
      }
      if (attached) {
        try { await hetzner.volumes.detach(ctx.input.volumeId); } catch { /* best-effort */ }
      }
      throw err;
    }
  },
};

const reattachVolumeOp: OpKindDefinition<ReattachVolumeInput> = {
  kind: "reattach_volume",
  label: "Reattach volume",
  resourceKeys: (input) => [`app:${input.fromAppId}`, `app:${input.toAppId}`],
  steps: [validate, detachFromSource, attachToTarget],
};

registerOp(reattachVolumeOp as OpKindDefinition<any>);

export default reattachVolumeOp;
export type { ReattachVolumeInput };
