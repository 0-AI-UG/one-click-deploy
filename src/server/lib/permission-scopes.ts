import { PermissionError } from "./errors.ts";
import { getUserById, hasPermission, type PermissionScope } from "../../shared/db.ts";
import db from "../../shared/db/connection.ts";
import type { TokenPayload } from "./auth.ts";

/** Pure scope resolvers and the CLI gate, kept out of permissions.ts because
 *  route test suites replace that module wholesale to bypass auth. Living here
 *  means these stay real (and testable) even under that mock. */

/** Scope for a route acting on one app. The app's environment is resolved by
 *  the permission layer, so this only needs the id. */
export function appScope(appId: number): PermissionScope {
  return { appId };
}

export function envScope(environmentId: number): PermissionScope {
  return { environmentId };
}

/** Scope for a route acting on a whole stack. A stack has no environment of its
 *  own, so a scoped grant has to cover *every* member: we return the members'
 *  shared environment when they agree, and otherwise `{}` — which no scoped
 *  grant can satisfy, forcing a global grant for cross-environment stacks.
 *  That is the safe direction; a per-member grant must not authorize an action
 *  that touches members the user was never given. */
export function stackScope(stackId: number): PermissionScope {
  const rows = db
    .query("SELECT DISTINCT environment_id FROM apps WHERE stack_id = ?")
    .all(stackId) as Array<{ environment_id: number | null }>;
  if (rows.length === 1 && rows[0].environment_id != null) {
    return { environmentId: rows[0].environment_id };
  }
  return {};
}

/** Every CLI-minted token additionally has to carry `cli.access`, regardless of
 *  which permission was requested — so revoking it locks an account to the web
 *  UI without touching any other grant. Non-CLI tokens are unaffected. */
export function assertCliAccess(payload: TokenPayload): void {
  if (payload.client !== "cli") return;
  const user = getUserById(payload.userId);
  if (user?.is_admin) return;
  if (!hasPermission(payload.userId, "cli.access")) {
    throw new PermissionError("CLI access is not enabled for this account");
  }
}
