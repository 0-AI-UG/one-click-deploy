import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken, verifyTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import * as db from "../../bun/db.ts";

/**
 * Verifies a 6-digit TOTP code OR an 8-char backup code for the given user.
 * Consumes the backup code on match. Returns true if accepted.
 */
export async function verifyTotpOrBackupCode(
  user: { id: string; username: string },
  code: string,
): Promise<boolean> {
  const secret = db.getTotpSecret(user.id);
  if (!secret) return false;

  const totp = createTOTP(secret, user.username);
  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) return true;

  const normalized = code.replace(/-/g, "").trim().toUpperCase();
  if (!normalized) return false;
  const unused = db.getUnusedBackupCodes(user.id);
  for (const bc of unused) {
    const match = await Bun.password.verify(normalized, bc.code_hash);
    if (match) {
      db.markBackupCodeUsed(bc.id);
      return true;
    }
  }
  return false;
}

export function createTOTP(secret: string, username: string): TOTP {
  return new TOTP({
    issuer: "OneClickDeploy",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function generateBackupCodes(count = 8): string[] {
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
      label: user.username,
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

    const totp = createTOTP(secret, user.username);
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
    const totp = createTOTP(secret, user.username);
    const delta = totp.validate({ token: body.code, window: 1 });

    if (delta !== null) {
      const token = await createToken({ userId: user.id, username: user.username });
      const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
      return Response.json(
        { token, user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1, totpEnabled: true, webauthnEnabled: user.webauthn_enabled === 1, githubLinked: !!user.github_id, githubUsername: user.github_username || "", githubAvatarUrl: user.github_avatar_url || "", permissions } },
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
        const token = await createToken({ userId: user.id, username: user.username });
        const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
        return Response.json(
          { token, user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1, totpEnabled: true, webauthnEnabled: user.webauthn_enabled === 1, githubLinked: !!user.github_id, githubUsername: user.github_username || "", githubAvatarUrl: user.github_avatar_url || "", permissions } },
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
      label: user.username,
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

    const totp = createTOTP(secret, user.username);
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
    const token = await createToken({ userId: user.id, username: user.username });
    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);

    return Response.json(
      { token, user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1, totpEnabled: true, webauthnEnabled: user.webauthn_enabled === 1, permissions }, backupCodes },
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

    // Block if disabling would leave user with no 2FA when required
    const require2fa = (db.getSettings().require_2fa ?? "1") === "1";
    if (!user.webauthn_enabled && (user.is_admin || require2fa)) {
      return Response.json(
        { error: "Cannot disable authenticator app: at least one 2FA method is required" },
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

    const totp = createTOTP(secret, user.username);
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

/**
 * POST /api/auth/totp/reset-from-login
 * "Lost your device" flow: consume a backup code to disable TOTP, then
 * require the user to immediately re-enroll. Returns a fresh temp token
 * that drives the /totp-setup screen.
 */
export async function handleTotpResetFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; backupCode?: string };
    if (!body.tempToken || !body.backupCode) {
      return Response.json(
        { error: "tempToken and backupCode are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    if (!user.totp_enabled) {
      return Response.json(
        { error: "TOTP is not enabled on this account" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Require a backup code specifically (not a TOTP code) — the whole point
    // of this flow is that the user has lost their authenticator.
    const normalized = body.backupCode.replace(/-/g, "").trim().toUpperCase();
    const unused = db.getUnusedBackupCodes(userId);
    let matched = false;
    for (const bc of unused) {
      const ok = await Bun.password.verify(normalized, bc.code_hash);
      if (ok) {
        db.markBackupCodeUsed(bc.id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      return Response.json(
        { error: "Invalid backup code" },
        { status: 400, headers: corsHeaders },
      );
    }

    db.disableTotp(userId);

    // If user still has webauthn, they still have 2FA — issue real JWT
    if (user.webauthn_enabled) {
      const token = await createToken({ userId: user.id, username: user.username });
      const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
      return Response.json(
        {
          token,
          user: {
            id: user.id,
            username: user.username,
            isAdmin: user.is_admin === 1,
            totpEnabled: false,
            webauthnEnabled: true,
            permissions,
          },
        },
        { headers: corsHeaders },
      );
    }

    // No 2FA left — force re-enrollment
    const tempToken = await createTempToken(userId);
    return Response.json(
      { requires2FASetup: true, tempToken },
      { headers: corsHeaders },
    );
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
    const webauthnEnabled = user.webauthn_enabled === 1;
    const required = user.is_admin === 1;
    const has2FA = enabled || webauthnEnabled;
    const backupCodesRemaining = has2FA ? db.getUnusedBackupCodeCount(userId) : 0;
    const webauthnCredentialCount = webauthnEnabled ? db.getWebAuthnCredentialCount(userId) : 0;

    return Response.json(
      { enabled, webauthnEnabled, webauthnCredentialCount, required, backupCodesRemaining },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
