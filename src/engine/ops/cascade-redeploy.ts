import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
} from "../../shared/db/operations.ts";
import { awaitChildren, type ChildSummary } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type CascadeRedeployInput = {
  environmentId: number;
  appIds?: number[];
  changedKeys?: string[];
  mode?: "redeploy" | "restart";
};

type ResolveOut = { appIds: number[] };
type EnqueueOut = { childOpIds: number[] };
type WaitOut = ChildSummary;

function shouldRedeploy(status: string): boolean {
  // Redeploy the actively-serving apps plus paused and sleeping (scale-to-zero)
  // ones — a redeploy recreates them from the current immutable image, so a
  // cascade (env-var change or stack redeploy) brings dormant members back up
  // on the new config instead of deferring to the next manual wake. Error /
  // failed / destroying apps are left alone.
  return (
    status === "running" ||
    status === "unhealthy" ||
    status === "deploying" ||
    status === "paused" ||
    status === "sleeping"
  );
}

const resolveApps: Step<CascadeRedeployInput, ResolveOut> = {
  name: "resolve_apps",
  label: "Resolve apps",
  async run(ctx) {
    const env = db.getEnvironment(ctx.input.environmentId);
    if (!env) throw new Error(`Environment ${ctx.input.environmentId} not found`);
    const apps = db.getAppsByEnvironmentId(ctx.input.environmentId);
    const requested = ctx.input.appIds ? new Set(ctx.input.appIds) : null;
    const changed = ctx.input.changedKeys ? new Set(ctx.input.changedKeys) : null;
    const appIds = apps
      .filter((a) => shouldRedeploy(a.status))
      .filter((a) => !requested || requested.has(a.id))
      .filter((a) => {
        if (!changed) return true;
        const projection = db.parseAppEnvProjection(a);
        return projection === null || projection.some((key) => changed.has(key));
      })
      .map((a) => a.id);
    ctx.log(`resolved ${appIds.length} app(s) for ${ctx.input.mode ?? "redeploy"} rollout from env ${env.name}`);
    return { appIds };
  },
};

const enqueueChildRedeploys: Step<CascadeRedeployInput, EnqueueOut> = {
  name: "enqueue_child_redeploys",
  label: "Enqueue child redeploys",
  async run(ctx, prior) {
    const { appIds } = prior["resolve_apps"] as ResolveOut;
    // Resume-safe: if children already exist from a prior attempt, reuse them.
    const existing = listChildOperations(ctx.opId);
    const existingByKey = new Map(existing.map((c) => [c.idempotency_key ?? "", c]));

    const childOpIds: number[] = [];
    const kind = ctx.input.mode === "restart" ? "reload_app" : "redeploy";
    for (const appId of appIds) {
      const key = `cascade:${ctx.opId}:${appId}`;
      const prev = existingByKey.get(key);
      if (prev) {
        childOpIds.push(prev.id);
        continue;
      }
      const row = enqueueOperation({
        kind,
        resourceKeys: [`app:${appId}`],
        input: { appId, userId: ctx.triggeredBy || undefined },
        trigger: "cascade",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: key,
      });
      childOpIds.push(row.id);
    }
    ctx.log(`enqueued ${childOpIds.length} child ${kind} op(s)`);
    return { childOpIds };
  },
};

const waitForChildren: Step<CascadeRedeployInput, WaitOut> = {
  name: "wait_for_children",
  label: "Wait for children",
  async run(ctx) {
    // Safe to re-enter: we look up children by parent_id, not from prior output.
    return await awaitChildren(ctx);
  },
};

const cascadeRedeployOp: OpKindDefinition<CascadeRedeployInput> = {
  kind: "cascade_redeploy",
  label: "Cascade redeploy",
  resourceKeys: (input) => [`env:${input.environmentId}`],
  steps: [resolveApps, enqueueChildRedeploys, waitForChildren],
};

registerOp(cascadeRedeployOp as OpKindDefinition<any>);

export default cascadeRedeployOp;
export type { CascadeRedeployInput };
