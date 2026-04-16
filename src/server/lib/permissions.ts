import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById, hasPermission } from "../../shared/db.ts";

export async function requirePermission(request: Request, permission: string): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (!hasPermission(payload.userId, permission)) {
    throw new PermissionError(`Missing permission: ${permission}`);
  }
  return payload;
}
