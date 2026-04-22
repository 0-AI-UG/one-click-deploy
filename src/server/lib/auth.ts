import { jwtVerify, SignJWT } from "jose";
import { AuthError } from "./errors.ts";
import * as db from "../../shared/db.ts";

export interface TokenPayload {
  userId: string;
  username: string;
  v?: number; // token_version for session revocation (optional for backward compat)
}

const isProd = process.env.NODE_ENV === "production" || process.env.BUN_ENV === "production";
const rawJwtSecret = process.env.JWT_SECRET;

if (isProd) {
  if (!rawJwtSecret || rawJwtSecret.length < 32) {
    console.error(
      "[auth] FATAL: JWT_SECRET must be set to at least 32 characters in production. " +
      "Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }
} else if (!rawJwtSecret) {
  console.warn(
    "⚠️  JWT_SECRET not set — using insecure dev default. DO NOT run this in production.",
  );
}

export const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawJwtSecret ?? "one-click-deploy-dev-secret"),
  ),
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
    // Validate token_version if the user has one set
    const user = db.getUserById(p.userId);
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
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
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
    const user = db.getUserById(userId);
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

