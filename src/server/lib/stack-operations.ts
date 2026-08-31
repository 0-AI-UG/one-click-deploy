import * as db from "../../shared/db.ts";
import dbConn from "../../shared/db/connection.ts";
import {
  getOperation,
  type EnqueueInput,
  type OperationRow,
} from "../../shared/db/operations.ts";

export function stackLockKeys(stack: Pick<db.StackRow, "id" | "name">): string[] {
  return [`stack:${stack.id}`, `stack:${stack.name}`];
}

/**
 * HTTP-triggered member operations must serialize with their owning stack's
 * reconcile/destroy operation. Engine-spawned children bypass this helper and
 * deliberately keep only their member key, otherwise a parent waiting on its
 * children would deadlock while retaining the stack lock.
 */
export function withOwningStackKeys(args: EnqueueInput): EnqueueInput {
  const keys = new Set(args.resourceKeys);
  for (const key of args.resourceKeys) {
    const match = /^app:(\d+)$/.exec(key);
    if (!match) continue;
    const id = Number(match[1]);
    let stackId: number | null = null;
    const app = db.getApp(id);
    if (!app) continue;
    stackId = app.stack_id;
    if (stackId == null && app.target_of != null) {
      stackId = db.getApp(app.target_of)?.stack_id ?? null;
    }
    if (stackId == null) continue;
    const stack = db.getStack(stackId);
    if (!stack) continue;
    keys.add(`stack:${stack.id}`);
    keys.add(`stack:${stack.name}`);
  }
  return { ...args, resourceKeys: [...keys] };
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
  return keys;
}

export function findLatestRelatedStackOperation(stack: db.StackRow): OperationRow | null {
  const related = relatedStackResourceKeys(stack);
  const rows = dbConn.query("SELECT * FROM operations ORDER BY id DESC").all() as OperationRow[];
  const latest = rows.find((op) => parseKeys(op).some((key) => related.has(key))) ?? null;
  if (!latest) return null;
  // A child is inserted after its stack operation, so ordering by id alone
  // made `stack status` replace parent #1810 with child #1815. Walk to the
  // durable root operation while retaining child detail separately in routes.
  let root = latest;
  const seen = new Set<number>();
  while (root.parent_id != null && !seen.has(root.parent_id)) {
    seen.add(root.parent_id);
    const parent = getOperation(root.parent_id);
    if (!parent) break;
    root = parent;
  }
  return root;
}
