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

const destroyMembers: Step<DestroyStackInput, { childIds: number[] }> = {
  name: "destroy_members",
  label: "Destroy stack members",
  async run(ctx) {
    const { stackId } = ctx.input;
    const byKey = new Map(
      listChildOperations(ctx.opId).map((c) => [c.idempotency_key ?? "", c]),
    );
    const childIds: number[] = [];

    const enqueueDestroy = (
      kind: "destroy_app" | "destroy_service",
      resourceKey: string,
      input: Record<string, number>,
      idk: string,
    ) => {
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); return; }
      const op: OperationRow = enqueueOperation({
        kind,
        resourceKeys: [resourceKey],
        input,
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(op.id);
    };

    for (const app of db.getAppsByStackId(stackId)) {
      enqueueDestroy("destroy_app", `app:${app.id}`, { appId: app.id }, `destroy_stack:${ctx.opId}:app:${app.id}`);
    }
    for (const svc of db.getServicesByStackId(stackId)) {
      enqueueDestroy("destroy_service", `service:${svc.id}`, { serviceId: svc.id }, `destroy_stack:${ctx.opId}:svc:${svc.id}`);
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
  steps: [destroyMembers, deleteStackRow],
};

registerOp(destroyStackOp as OpKindDefinition<any>);

export default destroyStackOp;
export type { DestroyStackInput };
