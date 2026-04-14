import { unpauseApp } from "../../bun/deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type UnpauseAppInput = { appId: number };

const unpauseReplicas: Step<UnpauseAppInput, { ok: true }> = {
  name: "unpause_replicas",
  label: "Unpause replicas",
  async run(ctx) {
    const result = await unpauseApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "unpauseApp returned ok=false");
    return { ok: true };
  },
};

const unpauseAppOp: OpKindDefinition<UnpauseAppInput> = {
  kind: "unpause_app",
  label: "Unpause app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [unpauseReplicas],
};

registerOp(unpauseAppOp as OpKindDefinition<any>);

export default unpauseAppOp;
export type { UnpauseAppInput };
