import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById, hasPermission } from "../../bun/db.ts";

export async function requirePermission(request: Request, permission: string): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (user.is_admin) return payload;
  if (!hasPermission(payload.userId, permission)) {
    throw new PermissionError(`Missing permission: ${permission}`);
  }
  return payload;
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (!user.is_admin) throw new PermissionError("Admin only");
  return payload;
}
