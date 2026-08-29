import { jwtVerify, SignJWT } from "jose";
import { AuthError, ForbiddenError } from "./errors.ts";
import { getUserById } from "../../shared/db.ts";
import { getJwtSecret } from "../../shared/secret-store.ts";

export interface TokenPayload {
  userId: string;
  username: string;
  v?: number; // token_version for session revocation (optional for backward compat)
  client?: "cli" | "ui-cli"; // browser tokens omit this; command runners carry their origin
}

const rawSecret = new TextEncoder().encode(getJwtSecret());
const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

export async function authenticateRequest(request: Request): Promise<TokenPayload> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  const token = header.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as Record<string, unknown>).purpose) throw new AuthError("Unauthorized");
    const p = payload as unknown as TokenPayload;
    // Validate token_version to support sign-out-all / password-reset revocation
    const user = getUserById(p.userId);
    if (!user) throw new AuthError("Unauthorized");
    if (typeof p.v === "number" && user.token_version !== undefined && p.v < user.token_version) {
      throw new AuthError("Unauthorized");
    }
    return p;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Unauthorized");
  }
}

export async function createToken(payload: TokenPayload): Promise<string> {
  // CLI credentials are explicitly approved through the device flow and are
  // also used by unattended CI. Keep them long-lived enough for automation,
  // while retaining immediate revocation through the user's token_version.
  const expiration = payload.client === "cli" ? "365d" : "7d";
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(JWT_SECRET);
}

/** Short-lived credential used by purpose-built UI actions executed through
 * the CLI. It deliberately does not carry the local-CLI gate: the originating
 * browser session is already authenticated and command-specific permissions
 * remain enforced by the normal API handlers. */
export async function createUiCliToken(payload: Omit<TokenPayload, "client">): Promise<string> {
  return new SignJWT({ ...payload, client: "ui-cli" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(JWT_SECRET);
}

export async function createTempToken(userId: string, v: number): Promise<string> {
  return new SignJWT({ userId, purpose: "2fa", v } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(JWT_SECRET);
}

export async function verifyTempToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const p = payload as Record<string, unknown>;
    if (p.purpose !== "2fa") throw new AuthError("Invalid token");
    const userId = p.userId as string;
    // Validate token_version to kill in-flight 2FA flows after a bump
    const user = getUserById(userId);
    if (!user) throw new AuthError("Invalid token");
    if (typeof p.v === "number" && user.token_version !== undefined && p.v < user.token_version) {
      throw new AuthError("Invalid token");
    }
    return userId;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user?.is_admin) {
    throw new ForbiddenError("Admin access required");
  }
  return payload;
}
