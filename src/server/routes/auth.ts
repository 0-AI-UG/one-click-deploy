import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import { verifyTotpOrBackupCode } from "./totp.ts";
import * as db from "../../shared/db.ts";

/** Build rate-limit keys for IP and/or username. */
function rateLimitKeys(request: Request, username?: string): string[] {
  const ip = getClientIP(request);
  const keys: string[] = [];
  if (ip) keys.push("ip:" + ip);
  if (username) keys.push("user:" + username.toLowerCase());
  return keys;
}

function checkRateLimitKeys(keys: string[]): Response | null {
  for (const key of keys) {
    const { limited, retryAfterSeconds } = authRateLimiter.isLimited(key);
    if (limited) {
      return Response.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) } },
      );
    }
  }
  return null;
}

function recordFailureKeys(keys: string[]): void {
  for (const key of keys) authRateLimiter.recordFailure(key);
}

export async function handleLogin(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const keys = rateLimitKeys(request, body.username);
    const rateLimitResponse = checkRateLimitKeys(keys);
    if (rateLimitResponse) return rateLimitResponse;

    const user = db.getUserByUsername(body.username);
    if (!user) {
      recordFailureKeys(keys);
      throw new AuthError("Invalid username or password");
    }

    const valid = await Bun.password.verify(body.password, user.password_hash);
    if (!valid) {
      recordFailureKeys(keys);
      throw new AuthError("Invalid username or password");
    }

    // Skip 2FA in dev mode
    if (process.env.SKIP_2FA !== "1") {
      // 2FA enabled: require verification
      const has2FA = user.totp_enabled || user.webauthn_enabled;
      if (has2FA) {
        const tempToken = await createTempToken(user.id, user.token_version);
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

      // 2FA not set up but required when the global REQUIRE_2FA env var is set
      const require2fa = process.env.REQUIRE_2FA !== "0";
      if (require2fa) {
        const tempToken = await createTempToken(user.id, user.token_version);
        return Response.json(
          { requires2FASetup: true, tempToken },
          { headers: corsHeaders },
        );
      }
    }

    // No 2FA required — issue full token
    const token = await createToken({ userId: user.id, username: user.username, v: user.token_version });
    const permissions = db.getUserPermissions(user.id);
    return Response.json(
      {
        token,
        user: {
          id: user.id,
          username: user.username,
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

/**
 * POST /api/auth/password-reset
 * Self-serve password reset gated by TOTP / backup code.
 * Body: { username, totpCode, newPassword }
 * Only works for users with TOTP enabled (no email delivery in this system).
 */
export async function handlePasswordReset(request: Request): Promise<Response> {
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

    const keys = rateLimitKeys(request, body.username);
    const rateLimitResponse = checkRateLimitKeys(keys);
    if (rateLimitResponse) return rateLimitResponse;

    const user = db.getUserByUsername(body.username);
    // Return the same error for unknown user / no TOTP / bad code so we
    // don't leak which usernames exist or which accounts have 2FA.
    const genericError = Response.json(
      { error: "Unable to reset password. Check your username and 2FA code." },
      { status: 400, headers: corsHeaders },
    );
    if (!user || !user.totp_enabled) {
      recordFailureKeys(keys);
      return genericError;
    }

    const ok = await verifyTotpOrBackupCode(user, body.totpCode);
    if (!ok) {
      recordFailureKeys(keys);
      return genericError;
    }

    const hash = await Bun.password.hash(body.newPassword, "bcrypt");
    db.updateUserPassword(user.id, hash);
    db.incrementTokenVersion(user.id);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRegister(request: Request): Promise<Response> {
  try {
    const { username, password } = await request.json() as { username?: string; password?: string };

    // Check IP-only limit before we have a validated username
    const ipKey = (() => { const ip = getClientIP(request); return ip ? "ip:" + ip : null; })();
    const ipKeys = ipKey ? [ipKey] : [];
    const ipLimitResp = checkRateLimitKeys(ipKeys);
    if (ipLimitResp) return ipLimitResp;

    if (!username || !password) {
      recordFailureKeys(ipKeys);
      return Response.json({ error: "Username and password required" }, { status: 400, headers: corsHeaders });
    }

    const keys = rateLimitKeys(request, username);
    const rateLimitResponse = checkRateLimitKeys(keys);
    if (rateLimitResponse) return rateLimitResponse;

    if (username.length < 3) {
      recordFailureKeys(keys);
      return Response.json({ error: "Username must be at least 3 characters" }, { status: 400, headers: corsHeaders });
    }
    if (password.length < 8) {
      recordFailureKeys(keys);
      return Response.json({ error: "Password must be at least 8 characters" }, { status: 400, headers: corsHeaders });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      recordFailureKeys(keys);
      return Response.json({ error: "Username must be alphanumeric" }, { status: 400, headers: corsHeaders });
    }

    const existing = db.getUserByUsername(username);
    if (existing) {
      recordFailureKeys(keys);
      return Response.json({ error: "Username already taken" }, { status: 409, headers: corsHeaders });
    }

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, "argon2id");
    db.insertUser({ id, username, password_hash: passwordHash });

    // Create JWT token — re-read user so we have the DB-set token_version (0)
    const newUser = db.getUserById(id)!;
    const token = await createToken({ userId: newUser.id, username: newUser.username, v: newUser.token_version });
    return Response.json({ token, user: { id, username } }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const permissions = db.getUserPermissions(userId);

    return Response.json(
      {
        user: {
          id: user.id,
          username: user.username,
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
    const permissions = db.getUserPermissions(userId);

    return Response.json(
      {
        user: {
          id: user.id,
          username: user.username,
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

/** POST /api/auth/sign-out-all — revoke all sessions by bumping token_version */
export async function handleSignOutAll(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    db.incrementTokenVersion(userId);
    const freshUser = db.getUserById(userId)!;
    const token = await createToken({ userId: freshUser.id, username: freshUser.username, v: freshUser.token_version });
    return Response.json({ ok: true, token }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

