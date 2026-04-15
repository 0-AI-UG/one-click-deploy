import { restartApp } from "../deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RestartAppInput = { appId: number };

const restartReplicas: Step<RestartAppInput, { ok: true }> = {
  name: "restart_replicas",
  label: "Restart replicas",
  async run(ctx) {
    const result = await restartApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "restartApp returned ok=false");
    return { ok: true };
  },
};

const restartAppOp: OpKindDefinition<RestartAppInput> = {
  kind: "restart_app",
  label: "Restart app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [restartReplicas],
};

registerOp(restartAppOp as OpKindDefinition<any>);

export default restartAppOp;
export type { RestartAppInput };
