import { pauseApp } from "../../bun/deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type PauseAppInput = { appId: number };

const pauseReplicas: Step<PauseAppInput, { ok: true }> = {
  name: "pause_replicas",
  label: "Pause replicas",
  async run(ctx) {
    const result = await pauseApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "pauseApp returned ok=false");
    return { ok: true };
  },
};

const pauseAppOp: OpKindDefinition<PauseAppInput> = {
  kind: "pause_app",
  label: "Pause app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [pauseReplicas],
};

registerOp(pauseAppOp as OpKindDefinition<any>);

export default pauseAppOp;
export type { PauseAppInput };
