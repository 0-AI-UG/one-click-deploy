import { authenticateRequest } from "./auth.ts";
import { BadRequestError, ForbiddenError } from "./errors.ts";
import { isOrgMember, getOrgRole, hasOrgPermission as dbHasOrgPermission } from "../../shared/db/orgs.ts";

export type OrgContext = {
  userId: string;
  username: string;
  orgId: string;
  orgRole: string; // 'owner' | 'member'
};

/**
 * Extract authenticated user + org context from request.
 * Reads org from X-Org-Id header. Validates membership.
 */
export async function requireOrgContext(request: Request): Promise<OrgContext> {
  const auth = await authenticateRequest(request);
  const orgId = request.headers.get("x-org-id");
  if (!orgId) {
    throw new BadRequestError("Missing X-Org-Id header");
  }
  const role = getOrgRole(orgId, auth.userId);
  if (!role) {
    throw new ForbiddenError("Not a member of this organization");
  }
  return { userId: auth.userId, username: auth.username, orgId, orgRole: role };
}

/**
 * Require org owner role.
 */
export async function requireOrgOwner(request: Request): Promise<OrgContext> {
  const ctx = await requireOrgContext(request);
  if (ctx.orgRole !== "owner") {
    throw new ForbiddenError("Org owner access required");
  }
  return ctx;
}

/**
 * Require a specific org-scoped permission.
 * Org owners bypass permission checks.
 */
export async function requireOrgPermission(request: Request, permission: string): Promise<OrgContext> {
  const ctx = await requireOrgContext(request);
  if (ctx.orgRole === "owner") return ctx;
  if (!dbHasOrgPermission(ctx.orgId, ctx.userId, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
  return ctx;
}
