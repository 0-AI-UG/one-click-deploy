import * as db from "../../shared/db.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RemountVolumeInput = { appId: number; mountPath: string };

type ValidateOut = {
  volumeId: string;
  previousMount: string;
  nextMount: string;
  volumeAttached: boolean;
  extraVolumes: string;
};

const validate: Step<RemountVolumeInput, ValidateOut> = {
  name: "validate",
  label: "Validate volume mount path",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app?.volume_id) throw new Error("App has no volume attached");
    if (!ctx.input.mountPath.startsWith("/")) throw new Error("Volume mount path must be absolute");
    const hostPath = app.volume_mount.split(":")[0];
    if (!hostPath) throw new Error("App volume host mount is missing");
    return {
      volumeId: app.volume_id,
      previousMount: app.volume_mount,
      nextMount: `${hostPath}:${ctx.input.mountPath}`,
      volumeAttached: !!app.volume_attached,
      extraVolumes: app.extra_volumes,
    };
  },
};

// Persist desired state separately from container convergence. If the engine
// dies after this write, probe adopts it and the recreate still runs. If a
// later step fails, this completed step owns restoration of both the previous
// DB value and the serving container.
const updateMount: Step<RemountVolumeInput, { ok: true }> = {
  name: "update_mount",
  label: "Record volume mount path",
  async probe(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const app = db.getApp(ctx.input.appId);
    if (
      app?.volume_id === v.volumeId &&
      app.volume_mount === v.nextMount &&
      !!app.volume_attached === v.volumeAttached
    ) {
      return { ok: true };
    }
    return null;
  },
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    db.updateAppVolume(ctx.input.appId, v.volumeId, v.nextMount, v.volumeAttached);
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const v = prior["validate"] as ValidateOut | undefined;
    if (!v) return;
    db.updateAppVolume(ctx.input.appId, v.volumeId, v.previousMount, v.volumeAttached);
    const result = await recreateAppContainer(
      ctx.input.appId,
      v.previousMount,
      db.parseExtraVolumes(v.extraVolumes),
    );
    if (!result.ok) throw new Error(result.error || "Failed to restore previous volume mount path");
  },
};

// Deliberately has no probe: the database alone cannot prove which mount the
// running container has. Recreating is idempotent and is the only safe way to
// converge after a crash between container replacement and finishStep.
const recreateContainer: Step<RemountVolumeInput, { ok: true }> = {
  name: "recreate_container",
  label: "Recreate container with new mount path",
  async run(ctx, prior) {
    const v = prior["validate"] as ValidateOut;
    const result = await recreateAppContainer(
      ctx.input.appId,
      v.nextMount,
      db.parseExtraVolumes(v.extraVolumes),
    );
    if (!result.ok) throw new Error(result.error || "Failed to recreate container with the manifest volume path");
    return { ok: true };
  },
};

const remountVolumeOp: OpKindDefinition<RemountVolumeInput> = {
  kind: "remount_volume",
  label: "Apply volume mount path",
  resourceKeys: (input) => {
    const volumeId = db.getApp(input.appId)?.volume_id;
    return [`app:${input.appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])];
  },
  steps: [validate, updateMount, recreateContainer],
};

registerOp(remountVolumeOp as OpKindDefinition<any>);
export default remountVolumeOp;
export type { RemountVolumeInput };
