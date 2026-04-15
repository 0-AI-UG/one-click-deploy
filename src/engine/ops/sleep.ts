import * as db from "../../shared/db.ts";
import { scaleDown } from "../scale/scale-down.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import type { App, Replica } from "../scale/types.ts";

type SleepInput = { appId: number };

type CheckOut = { alreadySleeping: boolean; currentCount: number };

// There is no separate sleepApp() helper — scale_to_zero goes through
// scaleDown(app, replicas, current, 0, emit), which stops containers, preserves
// the anchor replica, installs the wake page, and flips app status to
// "sleeping". We reuse it here rather than duplicating that logic.

const checkRunning: Step<SleepInput, CheckOut> = {
  name: "check_running",
  label: "Check running state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId) as Replica[];
    if (app.status === "sleeping") {
      return { alreadySleeping: true, currentCount: replicas.length };
    }
    return { alreadySleeping: false, currentCount: replicas.length };
  },
};

const stopContainers: Step<SleepInput, { ok: true; skipped?: boolean }> = {
  name: "stop_containers",
  label: "Stop containers",
  async run(ctx, prior) {
    const check = prior["check_running"] as CheckOut;
    if (check.alreadySleeping) return { ok: true, skipped: true };
    const app = db.getApp(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId) as Replica[];
    if (replicas.length === 0) return { ok: true, skipped: true };
    await scaleDown(app, replicas, replicas.length, 0, (step, detail) => {
      ctx.log(`[${step}] ${detail}`);
    });
    return { ok: true };
  },
};

const markSleeping: Step<SleepInput, { ok: true }> = {
  name: "mark_sleeping",
  label: "Mark sleeping",
  async run(ctx, prior) {
    const check = prior["check_running"] as CheckOut;
    if (check.alreadySleeping) return { ok: true };
    // scaleDown already sets app.status = sleeping and records a scaling event
    // when target=0. Record an additional autoscaler-labelled event so the
    // trigger shows up in scaling history.
    db.updateAppScaling(ctx.input.appId, {
      desired_replicas: 0,
      last_scale_at: new Date().toISOString(),
    });
    if (ctx.trigger === "autoscaler") {
      db.insertScalingEvent({
        app_id: ctx.input.appId,
        event_type: "autoscale_sleep",
        from_count: check.currentCount,
        to_count: 0,
        reason: "autoscaler",
      });
    }
    return { ok: true };
  },
};

const sleepOp: OpKindDefinition<SleepInput> = {
  kind: "sleep",
  label: "Sleep app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkRunning, stopContainers, markSleeping],
};

registerOp(sleepOp as OpKindDefinition<any>);

export default sleepOp;
export type { SleepInput };
