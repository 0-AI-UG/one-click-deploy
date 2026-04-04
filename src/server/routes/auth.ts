import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import { createTOTP } from "./totp.ts";
import * as db from "../../bun/db.ts";

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

export async function handleLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = db.getUserByEmail(body.email);
    if (!user) throw new AuthError("Invalid email or password");

    const valid = await Bun.password.verify(body.password, user.password_hash);
    if (!valid) throw new AuthError("Invalid email or password");

    // Skip 2FA in dev mode
    if (process.env.SKIP_2FA !== "1") {
      // 2FA enabled: require TOTP
      if (user.totp_enabled) {
        const tempToken = await createTempToken(user.id);
        return Response.json(
          { requires2FA: true, tempToken },
          { headers: corsHeaders },
        );
      }

      // 2FA not set up but required (admins always require 2FA)
      if (user.is_admin) {
        const tempToken = await createTempToken(user.id);
        return Response.json(
          { requires2FASetup: true, tempToken },
          { headers: corsHeaders },
        );
      }
    }

    // No 2FA required — issue full token
    const token = await createToken({ userId: user.id, email: user.email });
    return Response.json(
      { token, user: { id: user.id, email: user.email, isAdmin: false } },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);

    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.is_admin === 1,
          totpEnabled: user.totp_enabled === 1,
          permissions,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const body = await request.json() as { currentPassword?: string; newPassword?: string; totpCode?: string };

    if (body.newPassword) {
      if (!body.currentPassword) {
        return Response.json(
          { error: "Current password is required" },
          { status: 400, headers: corsHeaders },
        );
      }
      const user = db.getUserById(userId);
      if (!user) throw new AuthError("Unauthorized");
      const valid = await Bun.password.verify(body.currentPassword, user.password_hash);
      if (!valid) {
        return Response.json(
          { error: "Current password is incorrect" },
          { status: 400, headers: corsHeaders },
        );
      }

      // Require TOTP verification if enabled
      if (user.totp_enabled) {
        if (!body.totpCode) {
          return Response.json(
            { error: "A 2FA code is required to change your password" },
            { status: 400, headers: corsHeaders },
          );
        }
        const secret = db.getTotpSecret(userId);
        if (!secret) throw new AuthError("TOTP not configured");

        const totp = createTOTP(secret, user.email);
        const delta = totp.validate({ token: body.totpCode, window: 1 });

        if (delta === null) {
          // Try backup codes
          const normalizedCode = body.totpCode.replace(/-/g, "");
          const unusedCodes = db.getUnusedBackupCodes(userId);
          let backupMatch = false;
          for (const bc of unusedCodes) {
            const match = await Bun.password.verify(normalizedCode, bc.code_hash);
            if (match) {
              db.markBackupCodeUsed(bc.id);
              backupMatch = true;
              break;
            }
          }
          if (!backupMatch) {
            return Response.json(
              { error: "Invalid 2FA code" },
              { status: 400, headers: corsHeaders },
            );
          }
        }
      }

      if (body.newPassword.length < 8) {
        return Response.json(
          { error: "New password must be at least 8 characters" },
          { status: 400, headers: corsHeaders },
        );
      }
      const hash = await Bun.password.hash(body.newPassword, "bcrypt");
      db.updateUserPassword(userId, hash);
    }

    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);

    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.is_admin === 1,
          totpEnabled: user.totp_enabled === 1,
          permissions,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
