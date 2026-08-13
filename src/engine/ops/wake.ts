import * as db from "../../shared/db.ts";
import { wakeApp } from "../scale/wake.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type WakeInput = { appId: number };

type CheckOut = { wasSleeping: boolean };

// wakeApp() remains the shared recovery routine used by the synchronous waker.
// The engine boundary treats waking/error rows that still retain sleeping
// placement as resumable, and probes the complete published DB postcondition
// before rerunning it after an interrupted step.

const checkSleeping: Step<WakeInput, CheckOut> = {
  name: "check_sleeping",
  label: "Check sleep state",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    return {
      wasSleeping:
        app.status === "sleeping" ||
        ((app.status === "waking" || app.status === "error") &&
          app.sleeping_server_id != null && app.sleeping_host_port != null),
    };
  },
};

const startContainers: Step<WakeInput, { ok: boolean; skipped?: boolean }> = {
  name: "start_containers",
  label: "Start containers",
  async probe(ctx, prior) {
    const check = prior["check_sleeping"] as CheckOut | undefined;
    if (!check?.wasSleeping) return { ok: true, skipped: true };
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const published =
      app.status === "running" &&
      app.sleeping_server_id == null &&
      app.sleeping_host_port == null &&
      db.getReplicas(ctx.input.appId).some((replica) => replica.status === "running");
    return published ? { ok: true } : null;
  },
  async run(ctx, prior) {
    const check = prior["check_sleeping"] as CheckOut;
    if (!check.wasSleeping) return { ok: true, skipped: true };
    // Re-read current state: a concurrent wake may have already flipped it.
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const recoverable =
      (app.status === "sleeping" || app.status === "waking" || app.status === "error") &&
      app.sleeping_server_id != null && app.sleeping_host_port != null;
    if (!recoverable) {
      return { ok: true, skipped: true };
    }
    const result = await wakeApp(ctx.input.appId, ctx.opId);
    if (!result.ok) throw new Error(result.error || "Failed to wake app");
    return { ok: true };
  },
};

const syncIngressStep: Step<WakeInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const wakeOp: OpKindDefinition<WakeInput> = {
  kind: "wake",
  label: "Wake app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [checkSleeping, startContainers, syncIngressStep],
};

registerOp(wakeOp as OpKindDefinition<any>);

export default wakeOp;
export type { WakeInput };
