import * as db from "../../shared/db.ts";
import { unpauseApp } from "../deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type UnpauseAppInput = { appId: number };
type Precond = { alreadyInTarget: boolean };

const checkPrecondition: Step<UnpauseAppInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error(`app ${ctx.input.appId} not found`);
    // Already running/unhealthy means no unpause needed.
    if (app.status !== "paused") {
      ctx.log(`app ${app.name} is '${app.status}' (not paused) — no work needed`);
      return { alreadyInTarget: true };
    }
    return { alreadyInTarget: false };
  },
};

const unpauseReplicas: Step<UnpauseAppInput, { ok: true; skipped?: boolean }> = {
  name: "unpause_replicas",
  label: "Unpause replicas",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre?.alreadyInTarget) return { ok: true, skipped: true };
    const result = await unpauseApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "unpauseApp returned ok=false");
    return { ok: true };
  },
};

const unpauseAppOp: OpKindDefinition<UnpauseAppInput> = {
  kind: "unpause_app",
  label: "Unpause app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkPrecondition, unpauseReplicas],
};

registerOp(unpauseAppOp as OpKindDefinition<any>);

export default unpauseAppOp;
export type { UnpauseAppInput };
