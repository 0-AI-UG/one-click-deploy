import * as db from "../../shared/db.ts";
import { requireStorageDriver } from "../storage/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Resize a volume. This is a pure provider-side grow of the block device: it
// recreates no container and writes no app state, so there is nothing to
// compensate. (Deliberately no filesystem-grow logic — the old handler had
// none and this preserves that behaviour exactly.)

type ResizeVolumeInput = { volumeId: string; sizeGb: number; driverId?: string; serverId?: number };

function resolveVolume(input: ResizeVolumeInput) {
  const app = db.getApps().find((candidate) => candidate.volume_id === input.volumeId);
  const retired = db.getRetiredVolumes().find((candidate) => candidate.provider_volume_id === input.volumeId);
  const driverId = input.driverId || app?.volume_driver || retired?.driver_id;
  if (!driverId) throw new Error(`Cannot determine storage driver for volume ${input.volumeId}`);
  const replica = app ? db.getReplicas(app.id)[0] : undefined;
  const serverId = input.serverId ?? replica?.server_id;
  const server = serverId == null ? undefined : db.getServer(serverId) ?? undefined;
  return { driver: requireStorageDriver(driverId), server };
}

const resize: Step<ResizeVolumeInput, { ok: true }> = {
  name: "resize_volume",
  label: "Resize volume",
  async run(ctx) {
    const { driver, server } = resolveVolume(ctx.input);
    const before = await driver.inspect(ctx.input.volumeId, server);
    if (ctx.input.sizeGb < before.sizeGb) {
      throw new Error(
        `Refusing to shrink volume ${ctx.input.volumeId} from ${before.sizeGb}GB to ${ctx.input.sizeGb}GB; storage volumes are grow-only`,
      );
    }
    if (ctx.input.sizeGb > before.sizeGb) {
      await driver.resize(ctx.input.volumeId, ctx.input.sizeGb, server);
    }
    const confirmed = await driver.inspect(ctx.input.volumeId, server);
    if (driver.portable && confirmed.sizeGb < ctx.input.sizeGb) {
      throw new Error(
        `Storage driver did not confirm volume ${ctx.input.volumeId} resize: ` +
          `${confirmed.sizeGb}GB observed, ${ctx.input.sizeGb}GB requested`,
      );
    }
    ctx.log(`Volume ${ctx.input.volumeId} confirmed at ${confirmed.sizeGb}GB`);
    return { ok: true };
  },
};

const resizeVolumeOp: OpKindDefinition<ResizeVolumeInput> = {
  kind: "resize_volume",
  label: "Resize volume",
  resourceKeys: (input) => [`volume:${input.volumeId}`],
  steps: [resize],
};

registerOp(resizeVolumeOp as OpKindDefinition<any>);

export default resizeVolumeOp;
export type { ResizeVolumeInput };
