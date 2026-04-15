import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  requestCancel,
  type OperationRow,
  type OperationStatus,
} from "../../shared/db/operations.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type CascadeRedeployInput = { environmentId: number };

type ResolveOut = { appIds: number[] };
type EnqueueOut = { childOpIds: number[] };
type WaitOut = { succeeded: number; failed: number; cancelled: number };

const TERMINAL: ReadonlySet<OperationStatus> = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
]);

function isActiveApp(status: string): boolean {
  // Cascade only targets apps that are actually running. Stopped / destroying /
  // sleeping apps are skipped — they'll pick up the new env vars on next wake.
  return status === "running" || status === "unhealthy" || status === "deploying";
}

const resolveApps: Step<CascadeRedeployInput, ResolveOut> = {
  name: "resolve_apps",
  label: "Resolve apps",
  async run(ctx) {
    const env = db.getEnvironment(ctx.input.environmentId);
    if (!env) throw new Error(`Environment ${ctx.input.environmentId} not found`);
    const apps = db.getAppsByEnvironmentId(ctx.input.environmentId);
    const appIds = apps.filter((a) => isActiveApp(a.status)).map((a) => a.id);
    ctx.log(`resolved ${appIds.length} running app(s) attached to env ${env.name}`);
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
    for (const appId of appIds) {
      const key = `cascade:${ctx.opId}:${appId}`;
      const prev = existingByKey.get(key);
      if (prev) {
        childOpIds.push(prev.id);
        continue;
      }
      const row = enqueueOperation({
        kind: "redeploy",
        resourceKeys: [`app:${appId}`],
        input: { appId, userId: ctx.triggeredBy || undefined },
        trigger: "cascade",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: key,
      });
      childOpIds.push(row.id);
    }
    ctx.log(`enqueued ${childOpIds.length} child redeploy op(s)`);
    return { childOpIds };
  },
};

const waitForChildren: Step<CascadeRedeployInput, WaitOut> = {
  name: "wait_for_children",
  label: "Wait for children",
  async run(ctx) {
    // Safe to re-enter: we look up children by parent_id, not from prior output.
    const summarize = (rows: OperationRow[]): WaitOut => {
      let succeeded = 0, failed = 0, cancelled = 0;
      for (const r of rows) {
        if (r.status === "done") succeeded++;
        else if (r.status === "cancelled") cancelled++;
        else if (r.status === "failed" || r.status === "compensated") failed++;
      }
      return { succeeded, failed, cancelled };
    };

    // Release the engine concurrency slot while waiting, otherwise a batch of
    // cascade parents can occupy every slot and starve their own children.
    ctx.park();
    try {
      while (true) {
        const children = listChildOperations(ctx.opId);
        if (ctx.isCancelRequested()) {
          for (const c of children) {
            if (!TERMINAL.has(c.status)) {
              try { requestCancel(c.id); } catch (err) { ctx.log(`requestCancel #${c.id} failed: ${err}`); }
            }
          }
          throw new Error("cascade cancelled");
        }
        const allDone = children.length > 0 && children.every((c) => TERMINAL.has(c.status));
        if (children.length === 0 || allDone) {
          const summary = summarize(children);
          ctx.log(`children: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.cancelled} cancelled`);
          if (summary.failed > 0) {
            throw new Error(`cascade: ${summary.failed} child redeploy(s) failed (succeeded=${summary.succeeded})`);
          }
          return summary;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      ctx.unpark();
    }
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
