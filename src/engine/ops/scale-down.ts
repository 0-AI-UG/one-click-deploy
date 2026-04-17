import * as db from "../../shared/db.ts";
import { scaleDown } from "../scale/scale-down.ts";
import { syncAppCaddy } from "../scale/caddy-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import type { App, Replica } from "../scale/types.ts";

type ScaleDownInput = { appId: number; targetReplicas: number };

type ComputeOut = {
  currentCount: number;
  toRemove: number;
  touchedServerIds: number[];
};

const computeTarget: Step<ScaleDownInput, ComputeOut> = {
  name: "compute_target",
  label: "Compute scale target",
  async run(ctx) {
    const app = db.getAppUnscoped(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    const current = db.getReplicas(ctx.input.appId) as Replica[];
    const currentCount = current.length;
    const target = ctx.input.targetReplicas;
    if (target < 0) throw new Error("Replicas cannot be negative");
    if (target >= currentCount) {
      return { currentCount, toRemove: 0, touchedServerIds: [] };
    }
    return {
      currentCount,
      toRemove: currentCount - target,
      touchedServerIds: Array.from(new Set(current.map((r) => r.server_id))),
    };
  },
};

const removeReplicas: Step<ScaleDownInput, { removed: boolean }> = {
  name: "remove_replicas",
  label: "Remove replicas",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    if (compute.toRemove === 0) return { removed: false };
    const app = db.getAppUnscoped(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    const currentReplicas = db.getReplicas(ctx.input.appId) as Replica[];
    const currentCount = currentReplicas.length;
    const target = ctx.input.targetReplicas;
    if (currentCount <= target) return { removed: false }; // idempotent replay
    await scaleDown(app, currentReplicas, currentCount, target, (step, detail) => {
      ctx.log(`[${step}] ${detail}`);
    });
    return { removed: true };
  },
  // No compensation — scale-down reversal is a scale-up; not worth attempting.
};

const syncCaddyStep: Step<ScaleDownInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    if (compute.toRemove === 0) return { ok: true };
    // scaleDown already syncs Caddy. This is a belt-and-braces step that also
    // handles replays (where remove_replicas was a no-op but state might need
    // rewriting).
    try {
      if (ctx.input.targetReplicas > 0) await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const gcEmptyServers: Step<ScaleDownInput, { ok: true }> = {
  name: "gc_empty_servers",
  label: "GC empty servers",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    for (const sid of compute.touchedServerIds) {
      try {
        await db.gcServerIfEmpty(sid);
      } catch (err) {
        ctx.log(`gcServerIfEmpty(${sid}) failed: ${err}`);
      }
    }
    return { ok: true };
  },
};

const recordEvent: Step<ScaleDownInput, { ok: true }> = {
  name: "record_event",
  label: "Record scaling event",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    if (compute.toRemove === 0) return { ok: true };
    const target = ctx.input.targetReplicas;
    db.updateAppScaling(ctx.input.appId, {
      desired_replicas: target,
      last_scale_at: new Date().toISOString(),
    });
    const eventType = target === 0
      ? (ctx.trigger === "autoscaler" ? "autoscale_sleep" : "scale_down")
      : (ctx.trigger === "autoscaler" ? "autoscale_down" : "scale_down");
    db.insertScalingEvent({
      app_id: ctx.input.appId,
      event_type: eventType,
      from_count: compute.currentCount,
      to_count: target,
      reason: ctx.trigger === "autoscaler" ? "autoscaler" : "manual",
    });
    return { ok: true };
  },
};

const scaleDownOp: OpKindDefinition<ScaleDownInput> = {
  kind: "scale_down",
  label: "Scale app down",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [computeTarget, removeReplicas, syncCaddyStep, gcEmptyServers, recordEvent],
};

registerOp(scaleDownOp);

export default scaleDownOp;
export type { ScaleDownInput };
