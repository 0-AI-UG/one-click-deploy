import * as db from "../../bun/db.ts";
import { scaleUp, rollbackScaleUp } from "../../bun/scale/scale-up.ts";
import { syncAppCaddy } from "../../bun/scale/caddy-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import type { App, Replica } from "../../bun/scale/types.ts";

type ScaleUpInput = { appId: number; targetReplicas: number; targetServerId?: number };

type ComputeOut = {
  currentCount: number;
  toAdd: number;
  originalReplicaIds: number[];
};

type AddOut = {
  // IDs of replicas that existed before this op ran (used for rollback).
  originalReplicaIds: number[];
  newReplicaIds: number[];
  touchedServerIds: number[];
};

const computeTarget: Step<ScaleUpInput, ComputeOut> = {
  name: "compute_target",
  label: "Compute scale target",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    if (app.volume_id && ctx.input.targetReplicas > 1) {
      throw new Error("Apps with persistent storage cannot have more than 1 replica.");
    }
    const current = db.getReplicas(ctx.input.appId) as Replica[];
    const currentCount = current.length;
    const target = ctx.input.targetReplicas;
    if (target <= currentCount) {
      return {
        currentCount,
        toAdd: 0,
        originalReplicaIds: current.map((r) => r.id),
      };
    }
    return {
      currentCount,
      toAdd: target - currentCount,
      originalReplicaIds: current.map((r) => r.id),
    };
  },
};

const addReplicas: Step<ScaleUpInput, AddOut> = {
  name: "add_replicas_one_by_one",
  label: "Add replicas",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    const originalIds = new Set(compute.originalReplicaIds);
    if (compute.toAdd === 0) {
      return { originalReplicaIds: compute.originalReplicaIds, newReplicaIds: [], touchedServerIds: [] };
    }
    const app = db.getApp(ctx.input.appId) as App | null;
    if (!app) throw new Error("App not found");
    const currentReplicas = db.getReplicas(ctx.input.appId) as Replica[];
    const currentCount = currentReplicas.length;
    const target = ctx.input.targetReplicas;
    if (currentCount >= target) {
      // Idempotent replay: already at target.
      const newReplicaIds = db.getReplicas(ctx.input.appId)
        .filter((r) => !originalIds.has(r.id))
        .map((r) => r.id);
      return {
        originalReplicaIds: compute.originalReplicaIds,
        newReplicaIds,
        touchedServerIds: [],
      };
    }

    try {
      await scaleUp(app, currentReplicas, currentCount, target, (step, detail) => {
        ctx.log(`[${step}] ${detail}`);
      }, ctx.input.targetServerId);
    } catch (err) {
      // Throw so engine runs compensation.
      throw err;
    }

    const after = db.getReplicas(ctx.input.appId);
    const newReplicaIds = after.filter((r) => !originalIds.has(r.id)).map((r) => r.id);
    const touchedServerIds = Array.from(new Set(
      after.filter((r) => !originalIds.has(r.id)).map((r) => r.server_id),
    ));
    return {
      originalReplicaIds: compute.originalReplicaIds,
      newReplicaIds,
      touchedServerIds,
    };
  },
  async compensate(ctx, out, prior) {
    const compute = (prior["compute_target"] as ComputeOut | undefined);
    const app = db.getApp(ctx.input.appId) as App | null;
    if (!app) return;
    const originalReplicas: Replica[] = (compute
      ? db.getReplicas(ctx.input.appId).filter((r: Replica) => compute.originalReplicaIds.includes(r.id))
      : []) as Replica[];
    try {
      await rollbackScaleUp(app, originalReplicas, (step, detail) => {
        ctx.log(`[${step}] ${detail}`);
      });
    } catch (err) {
      ctx.log(`rollbackScaleUp failed: ${err}`);
    }
  },
};

const syncCaddyStep: Step<ScaleUpInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    if (compute.toAdd === 0) return { ok: true };
    try {
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const recordEvent: Step<ScaleUpInput, { ok: true }> = {
  name: "record_event",
  label: "Record scaling event",
  async run(ctx, prior) {
    const compute = prior["compute_target"] as ComputeOut;
    if (compute.toAdd === 0) return { ok: true };
    const target = ctx.input.targetReplicas;
    db.updateAppScaling(ctx.input.appId, {
      desired_replicas: target,
      last_scale_at: new Date().toISOString(),
    });
    db.insertScalingEvent({
      app_id: ctx.input.appId,
      event_type: ctx.trigger === "autoscaler" ? "autoscale_up" : "scale_up",
      from_count: compute.currentCount,
      to_count: target,
      reason: ctx.trigger === "autoscaler" ? "autoscaler" : "manual",
    });
    return { ok: true };
  },
};

const scaleUpOp: OpKindDefinition<ScaleUpInput> = {
  kind: "scale_up",
  label: "Scale app up",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [computeTarget, addReplicas, syncCaddyStep, recordEvent],
};

registerOp(scaleUpOp as OpKindDefinition<any>);

export default scaleUpOp;
export type { ScaleUpInput };
