import { jwtVerify, SignJWT } from "jose";
import { AuthError } from "./errors.ts";

export interface TokenPayload {
  userId: string;
  username: string;
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
    const p = payload as Record<string, unknown>;
    if (p.purpose !== "2fa") throw new AuthError("Invalid token");
    return p.userId as string;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

