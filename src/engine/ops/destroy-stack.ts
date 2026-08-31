import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  type OperationRow,
} from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyStackInput = { stackId: number };

type DestroyPlanOut = {
  stackName: string;
  appIds: number[];
};

const planDestroy: Step<DestroyStackInput, DestroyPlanOut> = {
  name: "plan_destroy",
  label: "Plan stack destruction",
  async run(ctx) {
    const stack = db.getStack(ctx.input.stackId);
    if (!stack) throw new Error(`Stack ${ctx.input.stackId} not found`);
    return {
      stackName: stack.name,
      appIds: db.getAppsByStackId(stack.id).map((app) => app.id).sort((a, b) => a - b),
    };
  },
};

const destroyMembers: Step<DestroyStackInput, { childIds: number[] }> = {
  name: "destroy_members",
  label: "Destroy stack members",
  async run(ctx, prior) {
    const { stackId } = ctx.input;
    const planned = prior["plan_destroy"] as DestroyPlanOut | undefined;
    const byKey = new Map(
      listChildOperations(ctx.opId).map((c) => [c.idempotency_key ?? "", c]),
    );
    const childIds: number[] = [];

    const enqueueDestroy = (
      kind: "destroy_app",
      resourceKey: string,
      input: Record<string, number>,
      idk: string,
    ) => {
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); return; }
      const resourceId = Number(Object.values(input)[0]);
      const volumeKeys = db.getApp(resourceId)?.volume_id ? [`volume:${db.getApp(resourceId)!.volume_id}`] : [];
      const op: OperationRow = enqueueOperation({
        kind,
        resourceKeys: [resourceKey, ...volumeKeys],
        input,
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(op.id);
    };

    const appIds = planned?.appIds ?? db.getAppsByStackId(stackId).map((app) => app.id);
    for (const appId of appIds) {
      enqueueDestroy("destroy_app", `app:${appId}`, { appId }, `destroy_stack:${ctx.opId}:app:${appId}`);
    }
    if (childIds.length > 0) {
      ctx.log(`destroying ${childIds.length} stack member(s)`);
      await awaitChildren(ctx, { childIds });
    }
    return { childIds };
  },
};

const deleteStackRow: Step<DestroyStackInput, { ok: true }> = {
  name: "delete_stack_row",
  label: "Delete stack",
  async probe(ctx) {
    return db.getStack(ctx.input.stackId) ? null : { ok: true };
  },
  async run(ctx) {
    const stack = db.getStack(ctx.input.stackId);
    if (stack?.environment_id) {
      ctx.log(`retaining environment #${stack.environment_id}; environments are only deleted explicitly`);
    }
    if (stack?.staging_environment_id) {
      ctx.log(`retaining staging environment #${stack.staging_environment_id}; environments are only deleted explicitly`);
    }
    db.deleteStack(ctx.input.stackId);
    ctx.log(`stack #${ctx.input.stackId} deleted`);
    return { ok: true };
  },
};

const destroyStackOp: OpKindDefinition<DestroyStackInput> = {
  kind: "destroy_stack",
  label: "Destroy stack",
  resourceKeys: (input) => [`stack:${input.stackId}`],
  steps: [planDestroy, destroyMembers, deleteStackRow],
};

registerOp(destroyStackOp as OpKindDefinition<any>);

export default destroyStackOp;
export type { DestroyStackInput };
