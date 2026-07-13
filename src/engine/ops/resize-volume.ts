import { hetzner } from "../../shared/providers/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Resize a volume. This is a pure provider-side grow of the block device: it
// recreates no container and writes no app state, so there is nothing to
// compensate. (Deliberately no filesystem-grow logic — the old handler had
// none and this preserves that behaviour exactly.)

type ResizeVolumeInput = { volumeId: string; sizeGb: number };

const resize: Step<ResizeVolumeInput, { ok: true }> = {
  name: "resize_volume",
  label: "Resize volume",
  async run(ctx) {
    await hetzner.volumes.resize(ctx.input.volumeId, ctx.input.sizeGb);
    ctx.log(`Resized volume ${ctx.input.volumeId} to ${ctx.input.sizeGb}GB`);
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
