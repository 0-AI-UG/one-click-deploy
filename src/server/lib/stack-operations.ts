import * as db from "../../shared/db.ts";
import dbConn from "../../shared/db/connection.ts";
import { requestCancel, type OperationRow } from "../../shared/db/operations.ts";

export function stackLockKeys(stack: Pick<db.StackRow, "id" | "name">): string[] {
  return [`stack:${stack.id}`, `stack:${stack.name}`];
}

function parseKeys(op: OperationRow): string[] {
  try {
    const value = JSON.parse(op.resource_keys);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/** Resource identities whose operations are meaningful on a stack detail/list
 * row. This deliberately includes the shared environments and each member, not
 * just deploy_stack/destroy_stack, so a later cascade or member failure is not
 * hidden behind an older successful stack deployment. */
export function relatedStackResourceKeys(stack: db.StackRow): Set<string> {
  const keys = new Set(stackLockKeys(stack));
  if (stack.environment_id != null) keys.add(`env:${stack.environment_id}`);
  if (stack.staging_environment_id != null) keys.add(`env:${stack.staging_environment_id}`);
  for (const app of db.getAppsByStackId(stack.id)) {
    keys.add(`app:${app.id}`);
    keys.add(`app:${app.name}`);
    keys.add(`app:create:${app.name}`);
  }
  for (const service of db.getServicesByStackId(stack.id)) {
    keys.add(`service:${service.id}`);
    keys.add(`service:${service.name}`);
    keys.add(`service:create:${service.name}`);
  }
  return keys;
}

export function findLatestRelatedStackOperation(stack: db.StackRow): OperationRow | null {
  const related = relatedStackResourceKeys(stack);
  const rows = dbConn.query("SELECT * FROM operations ORDER BY id DESC").all() as OperationRow[];
  return rows.find((op) => parseKeys(op).some((key) => related.has(key))) ?? null;
}

function owningStackForApp(appId: number): db.StackRow | null {
  const app = db.getApp(appId);
  if (!app) return null;
  const stackId = app.stack_id ?? (app.target_of != null ? db.getApp(app.target_of)?.stack_id : null);
  return stackId == null ? null : db.getStack(stackId);
}

/** Refuse incoming webhook work as soon as destruction is durably queued, not
 * only after the destroy operation acquires its scheduler lock. */
export function isStackDestructionActiveForApp(appId: number): boolean {
  const stack = owningStackForApp(appId);
  if (!stack) return false;
  const lockKeys = new Set(stackLockKeys(stack));
  const rows = dbConn
    .query(
      `SELECT * FROM operations
       WHERE kind = 'destroy_stack'
         AND status IN ('pending', 'running', 'compensating')
       ORDER BY id DESC`,
    )
    .all() as OperationRow[];
  return rows.some((op) => parseKeys(op).some((key) => lockKeys.has(key)));
}

/** Supersede every queued/running webhook deployment for a stack. Pending work
 * is dropped immediately; running work observes cancel_requested and
 * compensates before destruction acquires the shared stack lock. */
export function suspendStackWebhookOperations(stack: db.StackRow): number[] {
  const related = relatedStackResourceKeys(stack);
  const rows = dbConn
    .query(
      `SELECT * FROM operations
       WHERE trigger = 'webhook'
         AND status IN ('pending', 'running', 'compensating')
       ORDER BY id ASC`,
    )
    .all() as OperationRow[];
  const cancelled: number[] = [];
  for (const op of rows) {
    if (!parseKeys(op).some((key) => related.has(key))) continue;
    requestCancel(op.id);
    cancelled.push(op.id);
  }
  return cancelled;
}
