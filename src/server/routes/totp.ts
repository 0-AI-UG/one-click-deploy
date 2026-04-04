import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, verifyTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import * as db from "../../bun/db.ts";

export function createTOTP(secret: string, email: string): TOTP {
  return new TOTP({
    issuer: "OneClickDeploy",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 8; j++) {
      raw += chars[Math.floor(Math.random() * chars.length)];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

function checkRateLimit(request: Request): Response | null {
  const ip = getClientIP(request);
  const { allowed, retryAfterSeconds } = authRateLimiter.check(ip);
  if (!allowed) {
    return Response.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) } },
    );
  }
  return null;
}

/** POST /api/auth/totp/setup — start TOTP setup (authenticated) */
export async function handleTotpSetup(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    if (user.totp_enabled) {
      return Response.json(
        { error: "TOTP is already enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "OneClickDeploy",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    db.setTotpSecret(userId, secret.base32);
    const qrCode = await QRCode.toDataURL(uri);

    return Response.json(
      { secret: secret.base32, uri, qrCode },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/confirm — confirm TOTP setup (authenticated) */
export async function handleTotpConfirm(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as { code?: string };
    if (!body.code || body.code.length !== 6) {
      return Response.json(
        { error: "A 6-digit code is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = db.getTotpSecret(userId);
    if (!secret) {
      return Response.json(
        { error: "No TOTP setup in progress. Call /setup first." },
        { status: 400, headers: corsHeaders },
      );
    }

    const totp = createTOTP(secret, user.email);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const backupCodes = generateBackupCodes(8);
    const codeHashes = await Promise.all(
      backupCodes.map((code) => Bun.password.hash(code.replace("-", ""), "bcrypt")),
    );

    db.enableTotp(userId);
    db.insertBackupCodes(userId, codeHashes);

    return Response.json(
      { enabled: true, backupCodes },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/login — verify 2FA code during login */
export async function handleTotpLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string };
    if (!body.tempToken || !body.code) {
      return Response.json(
        { error: "tempToken and code are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const secret = db.getTotpSecret(userId);
    if (!secret) throw new AuthError("TOTP not configured");

    // Try TOTP code
    const totp = createTOTP(secret, user.email);
    const delta = totp.validate({ token: body.code, window: 1 });

    if (delta !== null) {
      const token = await createToken({ userId: user.id, email: user.email });
      const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
      return Response.json(
        { token, user: { id: user.id, email: user.email, isAdmin: user.is_admin === 1, totpEnabled: true, permissions } },
        { headers: corsHeaders },
      );
    }

    // Try backup codes
    const normalizedCode = body.code.replace(/-/g, "");
    const unusedCodes = db.getUnusedBackupCodes(userId);
    for (const bc of unusedCodes) {
      const match = await Bun.password.verify(normalizedCode, bc.code_hash);
      if (match) {
        db.markBackupCodeUsed(bc.id);
        const token = await createToken({ userId: user.id, email: user.email });
        const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
        return Response.json(
          { token, user: { id: user.id, email: user.email, isAdmin: user.is_admin === 1, totpEnabled: true, permissions } },
          { headers: corsHeaders },
        );
      }
    }

    return Response.json(
      { error: "Invalid code" },
      { status: 400, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/setup-from-login — setup TOTP during login (uses temp token) */
export async function handleTotpSetupFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string };
    if (!body.tempToken) {
      return Response.json(
        { error: "tempToken is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    if (user.totp_enabled) {
      return Response.json(
        { error: "TOTP is already enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "OneClickDeploy",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    db.setTotpSecret(userId, secret.base32);
    const qrCode = await QRCode.toDataURL(uri);

    return Response.json(
      { secret: secret.base32, uri, qrCode },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/confirm-from-login — confirm TOTP setup during login (uses temp token) */
export async function handleTotpConfirmFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string };
    if (!body.tempToken || !body.code || body.code.length !== 6) {
      return Response.json(
        { error: "tempToken and a 6-digit code are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const secret = db.getTotpSecret(userId);
    if (!secret) {
      return Response.json(
        { error: "No TOTP setup in progress" },
        { status: 400, headers: corsHeaders },
      );
    }

    const totp = createTOTP(secret, user.email);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const backupCodes = generateBackupCodes(8);
    const codeHashes = await Promise.all(
      backupCodes.map((code) => Bun.password.hash(code.replace("-", ""), "bcrypt")),
    );

    db.enableTotp(userId);
    db.insertBackupCodes(userId, codeHashes);

    // Issue real JWT since setup is complete
    const token = await createToken({ userId: user.id, email: user.email });
    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);

    return Response.json(
      { token, user: { id: user.id, email: user.email, isAdmin: user.is_admin === 1, totpEnabled: true, permissions }, backupCodes },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/disable — disable TOTP (authenticated) */
export async function handleTotpDisable(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    // Admins cannot disable 2FA
    if (user.is_admin) {
      return Response.json(
        { error: "Two-factor authentication is required for admin accounts" },
        { status: 403, headers: corsHeaders },
      );
    }

    if (!user.totp_enabled) {
      return Response.json(
        { error: "TOTP is not enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const body = await request.json() as { code?: string };
    if (!body.code) {
      return Response.json(
        { error: "A TOTP code is required to disable 2FA" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = db.getTotpSecret(userId);
    if (!secret) throw new AuthError("TOTP not configured");

    const totp = createTOTP(secret, user.email);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code" },
        { status: 400, headers: corsHeaders },
      );
    }

    db.disableTotp(userId);
    return Response.json({ disabled: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/totp/status */
export async function handleTotpStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const enabled = user.totp_enabled === 1;
    const required = user.is_admin === 1;
    const backupCodesRemaining = enabled ? db.getUnusedBackupCodeCount(userId) : 0;

    return Response.json(
      { enabled, required, backupCodesRemaining },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
