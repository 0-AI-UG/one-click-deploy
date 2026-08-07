import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById, hasPermission, type PermissionScope } from "../../shared/db.ts";
import { assertCliAccess } from "./permission-scopes.ts";

// Re-exported so routes have a single import site for the permission layer.
export { appScope, envScope, stackScope, assertCliAccess } from "./permission-scopes.ts";

/** Authenticate, then check a permission — optionally against one resource.
 *
 *  Omitting `scope` asks the fleet-wide question, which only a global grant can
 *  answer. Routes that act on a single app or environment should always pass a
 *  scope (see `appScope` / `stackScope`), otherwise a user holding a narrowly
 *  scoped grant is rejected on a resource they were explicitly given. */
export async function requirePermission(
  request: Request,
  permission: string,
  scope?: PermissionScope,
): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");

  assertCliAccess(payload);

  if (user.is_admin) return payload;
  if (!hasPermission(payload.userId, permission, scope)) {
    throw new PermissionError(`Missing permission: ${permission}`);
  }
  return payload;
}

/** Require a permission through a CLI-minted token.
 *
 * Desired-state entry points use this instead of duplicating client checks in
 * individual routes. Browser sessions may operate resources, but cannot apply
 * manifests or create manifest-owned resources.
 */
export async function requireCliPermission(
  request: Request,
  permission: string,
  scope?: PermissionScope,
): Promise<TokenPayload> {
  const payload = await requirePermission(request, permission, scope);
  if (payload.client !== "cli") {
    throw new PermissionError("This action is only available through the ocd CLI");
  }
  return payload;
}

/** Authenticate with no permission requirement, but still enforce cli.access.
 *  For the handful of routes that are open to any signed-in user. */
export async function requireAuthenticated(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  assertCliAccess(payload);
  return payload;
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (!user.is_admin) throw new PermissionError("Admin only");
  return payload;
}
