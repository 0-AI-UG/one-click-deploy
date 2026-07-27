import * as db from "../../shared/db.ts";
import dbConn from "../../shared/db/connection.ts";
import type { OperationRow } from "../../shared/db/operations.ts";

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
