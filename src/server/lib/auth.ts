import { jwtVerify, SignJWT } from "jose";
import { AuthError, ForbiddenError } from "./errors.ts";
import { getUserById } from "../../bun/db.ts";

export interface TokenPayload {
  userId: string;
  email: string;
}

const rawSecret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "one-click-deploy-dev-secret",
);
const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

export const IS_BOOTSTRAP = process.env.OCD_BOOTSTRAP === "1";

const BOOTSTRAP_IDENTITY: TokenPayload = { userId: "bootstrap", email: "bootstrap@localhost" };

export async function authenticateRequest(request: Request): Promise<TokenPayload> {
  if (IS_BOOTSTRAP) return BOOTSTRAP_IDENTITY;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  const token = header.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose) throw new AuthError("Unauthorized");
    return payload as unknown as TokenPayload;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Unauthorized");
  }
}

export async function createToken(payload: TokenPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export async function createTempToken(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: "2fa" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(JWT_SECRET);
}

export async function verifyTempToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose !== "2fa") throw new AuthError("Invalid token");
    return (payload as any).userId;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  if (IS_BOOTSTRAP) return payload;
  const user = getUserById(payload.userId);
  if (!user?.is_admin) {
    throw new ForbiddenError("Admin access required");
  }
  return payload;
}
