import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import { verifyTotpOrBackupCode } from "./totp.ts";
import * as db from "../../bun/db.ts";

function checkRateLimit(request: Request): Response | null {
  const ip = getClientIP(request);
  const { limited, retryAfterSeconds } = authRateLimiter.isLimited(ip);
  if (limited) {
    return Response.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) } },
    );
  }
  return null;
}

function recordFailure(request: Request): void {
  authRateLimiter.recordFailure(getClientIP(request));
}

export async function handleLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = db.getUserByUsername(body.username);
    if (!user) throw new AuthError("Invalid username or password");

    const valid = await Bun.password.verify(body.password, user.password_hash);
    if (!valid) throw new AuthError("Invalid username or password");

    // Skip 2FA in dev mode
    if (process.env.SKIP_2FA !== "1") {
      // 2FA enabled: require verification
      const has2FA = user.totp_enabled || user.webauthn_enabled;
      if (has2FA) {
        const tempToken = await createTempToken(user.id);
        return Response.json(
          {
            requires2FA: true,
            tempToken,
            methods: {
              totp: !!user.totp_enabled,
              webauthn: !!user.webauthn_enabled,
            },
          },
          { headers: corsHeaders },
        );
      }

      // 2FA not set up but required (admins always require 2FA;
      // others only when the global require_2fa setting is on)
      const require2fa = (db.getSettings().require_2fa ?? "1") === "1";
      if (user.is_admin || require2fa) {
        const tempToken = await createTempToken(user.id);
        return Response.json(
          { requires2FASetup: true, tempToken },
          { headers: corsHeaders },
        );
      }
    }

    // No 2FA required — issue full token
    const token = await createToken({ userId: user.id, username: user.username });
    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(user.id);
    return Response.json(
      {
        token,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.is_admin === 1,
          totpEnabled: user.totp_enabled === 1,
          webauthnEnabled: user.webauthn_enabled === 1,
          githubLinked: !!user.github_id,
          githubUsername: user.github_username || "",
          githubAvatarUrl: user.github_avatar_url || "",
          permissions,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    if (error instanceof AuthError) recordFailure(request);
    return handleError(error);
  }
}

/**
 * POST /api/auth/password-reset
 * Self-serve password reset gated by TOTP / backup code.
 * Body: { username, totpCode, newPassword }
 * Only works for users with TOTP enabled (no email delivery in this system).
 */
export async function handlePasswordReset(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as {
      username?: string;
      totpCode?: string;
      newPassword?: string;
    };
    if (!body.username || !body.totpCode || !body.newPassword) {
      return Response.json(
        { error: "Username, 2FA code, and new password are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (body.newPassword.length < 8) {
      return Response.json(
        { error: "New password must be at least 8 characters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = db.getUserByUsername(body.username);
    // Return the same error for unknown user / no TOTP / bad code so we
    // don't leak which usernames exist or which accounts have 2FA.
    const genericError = Response.json(
      { error: "Unable to reset password. Check your username and 2FA code." },
      { status: 400, headers: corsHeaders },
    );
    if (!user || !user.totp_enabled) {
      recordFailure(request);
      return genericError;
    }

    const ok = await verifyTotpOrBackupCode(user, body.totpCode);
    if (!ok) {
      recordFailure(request);
      return genericError;
    }

    const hash = await Bun.password.hash(body.newPassword, "bcrypt");
    db.updateUserPassword(user.id, hash);

    return Response.json({ ok: true }, { headers: corsHeaders });
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
          username: user.username,
          isAdmin: user.is_admin === 1,
          totpEnabled: user.totp_enabled === 1,
          webauthnEnabled: user.webauthn_enabled === 1,
          githubLinked: !!user.github_id,
          githubUsername: user.github_username || "",
          githubAvatarUrl: user.github_avatar_url || "",
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

      // Require 2FA verification if enabled
      if (user.totp_enabled || user.webauthn_enabled) {
        if (!body.totpCode) {
          return Response.json(
            { error: "A 2FA code is required to change your password" },
            { status: 400, headers: corsHeaders },
          );
        }
        const ok = await verifyTotpOrBackupCode(user, body.totpCode);
        if (!ok) {
          return Response.json(
            { error: "Invalid 2FA code" },
            { status: 400, headers: corsHeaders },
          );
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
          username: user.username,
          isAdmin: user.is_admin === 1,
          totpEnabled: user.totp_enabled === 1,
          webauthnEnabled: user.webauthn_enabled === 1,
          githubLinked: !!user.github_id,
          githubUsername: user.github_username || "",
          githubAvatarUrl: user.github_avatar_url || "",
          permissions,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
