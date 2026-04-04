import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById, hasPermission } from "../../bun/db.ts";

export async function requirePermission(request: Request, permission: string): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  // Desktop mode: synthetic user has all permissions
  if (payload.userId === "desktop") return payload;
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (user.is_admin) return payload;
  if (!hasPermission(payload.userId, permission)) {
    throw new PermissionError(`Missing permission: ${permission}`);
  }
  return payload;
}
