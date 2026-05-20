import * as db from "../../shared/db.ts";
import { pauseApp } from "../deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type PauseAppInput = { appId: number };
type Precond = { alreadyInTarget: boolean };

const checkPrecondition: Step<PauseAppInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error(`app ${ctx.input.appId} not found`);
    if (app.status === "paused") {
      ctx.log(`app ${app.name} already paused — no work needed`);
      return { alreadyInTarget: true };
    }
    return { alreadyInTarget: false };
  },
};

const pauseReplicas: Step<PauseAppInput, { ok: true; skipped?: boolean }> = {
  name: "pause_replicas",
  label: "Pause replicas",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre?.alreadyInTarget) return { ok: true, skipped: true };
    const result = await pauseApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "pauseApp returned ok=false");
    return { ok: true };
  },
};

const pauseAppOp: OpKindDefinition<PauseAppInput> = {
  kind: "pause_app",
  label: "Pause app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkPrecondition, pauseReplicas],
};

registerOp(pauseAppOp as OpKindDefinition<any>);

export default pauseAppOp;
export type { PauseAppInput };
