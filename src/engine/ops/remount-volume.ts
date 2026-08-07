import * as db from "../../shared/db.ts";
import { recreateAppContainer } from "../deploy/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RemountVolumeInput = { appId: number; mountPath: string };
type RemountOut = { previousMount: string; nextMount: string };

const remount: Step<RemountVolumeInput, RemountOut> = {
  name: "remount_volume",
  label: "Apply volume mount path",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app?.volume_id) throw new Error("App has no volume attached");
    if (!ctx.input.mountPath.startsWith("/")) throw new Error("Volume mount path must be absolute");
    const hostPath = app.volume_mount.split(":")[0];
    if (!hostPath) throw new Error("App volume host mount is missing");
    const nextMount = `${hostPath}:${ctx.input.mountPath}`;
    const previousMount = app.volume_mount;
    if (nextMount === previousMount) return { previousMount, nextMount };
    db.updateAppVolume(app.id, app.volume_id, nextMount, !!app.volume_attached);
    const result = await recreateAppContainer(app.id, nextMount, db.parseExtraVolumes(app.extra_volumes));
    if (!result.ok) throw new Error(result.error || "Failed to recreate container with the manifest volume path");
    return { previousMount, nextMount };
  },
  async compensate(ctx, out) {
    const app = db.getApp(ctx.input.appId);
    if (!app?.volume_id || !out) return;
    db.updateAppVolume(app.id, app.volume_id, out.previousMount, !!app.volume_attached);
    const result = await recreateAppContainer(app.id, out.previousMount, db.parseExtraVolumes(app.extra_volumes));
    if (!result.ok) throw new Error(result.error || "Failed to restore previous volume mount path");
  },
};

const remountVolumeOp: OpKindDefinition<RemountVolumeInput> = {
  kind: "remount_volume",
  label: "Apply volume mount path",
  resourceKeys: (input) => {
    const volumeId = db.getApp(input.appId)?.volume_id;
    return [`app:${input.appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])];
  },
  steps: [remount],
};

registerOp(remountVolumeOp as OpKindDefinition<any>);
export default remountVolumeOp;
export type { RemountVolumeInput };
