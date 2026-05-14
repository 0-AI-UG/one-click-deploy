import * as db from "../../shared/db.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppCaddy } from "../scale/caddy-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type WakeInput = { appId: number };

type CheckOut = { wasSleeping: boolean };

// wakeApp() is itself the recovery routine: starts containers, health-checks,
// upserts replica rows, clears sleeping state, syncs Caddy, and records an
// event. We wrap it as a single step and skip on replay if the app is no
// longer sleeping. No compensations — a partial wake is resolved by
// re-enqueueing another wake op.

const checkSleeping: Step<WakeInput, CheckOut> = {
  name: "check_sleeping",
  label: "Check sleep state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    return { wasSleeping: app.status === "sleeping" };
  },
};

const startContainers: Step<WakeInput, { ok: boolean; skipped?: boolean }> = {
  name: "start_containers",
  label: "Start containers",
  async run(ctx, prior) {
    const check = prior["check_sleeping"] as CheckOut;
    if (!check.wasSleeping) return { ok: true, skipped: true };
    // Re-read current state: a concurrent wake may have already flipped it.
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (app.status !== "sleeping" && app.status !== "waking") {
      return { ok: true, skipped: true };
    }
    const result = await wakeApp(ctx.input.appId);
    if (!result.ok) throw new Error(result.error || "Failed to wake app");
    return { ok: true };
  },
};

const syncCaddyStep: Step<WakeInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx) {
    try {
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const wakeOp: OpKindDefinition<WakeInput> = {
  kind: "wake",
  label: "Wake app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkSleeping, startContainers, syncCaddyStep],
};

registerOp(wakeOp as OpKindDefinition<any>);

export default wakeOp;
export type { WakeInput };
