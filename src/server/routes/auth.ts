import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
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

function userResponse(user: db.UserRow) {
  const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(user.id);
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    webauthnEnabled: user.webauthn_enabled === 1,
    githubLinked: !!user.github_id,
    githubUsername: user.github_username || "",
    githubAvatarUrl: user.github_avatar_url || "",
    permissions,
  };
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
      if (user.webauthn_enabled) {
        const tempToken = await createTempToken(user.id, user.token_version);
        return Response.json(
          { requires2FA: true, tempToken },
          { headers: corsHeaders },
        );
      }

      // Passkey not set up but required (admins always require 2FA;
      // others only when the global require_2fa setting is on)
      const require2fa = (db.getSettings().require_2fa ?? "1") === "1";
      if (user.is_admin || require2fa) {
        const tempToken = await createTempToken(user.id, user.token_version);
        return Response.json(
          { requires2FASetup: true, tempToken },
          { headers: corsHeaders },
        );
      }
    }

    // No 2FA required — issue full token
    const token = await createToken({ userId: user.id, username: user.username, v: user.token_version });
    return Response.json(
      { token, user: userResponse(user) },
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

    return Response.json(
      { user: userResponse(user) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const body = await request.json() as { currentPassword?: string; newPassword?: string };

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

    return Response.json(
      { user: userResponse(user) },
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
