import * as db from "../../shared/db.ts";
import { restartApp } from "../deploy/lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RestartAppInput = { appId: number };
type Precond = { runnable: boolean; reason?: string };

const checkPrecondition: Step<RestartAppInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error(`app ${ctx.input.appId} not found`);
    // Restart only makes sense for live apps. Paused/sleeping/destroying apps
    // are explicitly NOT restarted — caller should unpause/wake first.
    if (
      app.status === "paused" ||
      app.status === "sleeping" ||
      app.status === "destroying" ||
      app.status === "cleanup_failed" ||
      app.status === "deploying"
    ) {
      ctx.log(`app ${app.name} status='${app.status}' — restart skipped`);
      return { runnable: false, reason: `status=${app.status}` };
    }
    return { runnable: true };
  },
};

const restartReplicas: Step<RestartAppInput, { ok: true; skipped?: boolean }> = {
  name: "restart_replicas",
  label: "Restart replicas",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre && !pre.runnable) return { ok: true, skipped: true };
    const result = await restartApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "restartApp returned ok=false");
    return { ok: true };
  },
};

const restartAppOp: OpKindDefinition<RestartAppInput> = {
  kind: "restart_app",
  label: "Restart app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkPrecondition, restartReplicas],
};

registerOp(restartAppOp as OpKindDefinition<any>);

export default restartAppOp;
export type { RestartAppInput };
