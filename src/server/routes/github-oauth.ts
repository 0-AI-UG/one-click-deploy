import { SignJWT, jwtVerify } from "jose";
import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [github-oauth:${context}]`, ...args);
}

const rawSecret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "one-click-deploy-dev-secret",
);
const OAUTH_STATE_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

async function createStateToken(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: "github-oauth" } as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(OAUTH_STATE_SECRET);
}

async function verifyStateToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, OAUTH_STATE_SECRET);
  const p = payload as Record<string, unknown>;
  if (p.purpose !== "github-oauth") throw new Error("Invalid state");
  return p.userId as string;
}

function getPanelOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

/** GET /api/auth/github/authorize — returns the GitHub OAuth URL to redirect to */
export async function handleGitHubAuthorize(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    if (!clientId) {
      return Response.json(
        { error: "GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET environment variables." },
        { status: 400, headers: corsHeaders },
      );
    }

    const state = await createStateToken(userId);
    const origin = getPanelOrigin(request);
    const redirectUri = `${origin}/api/auth/github/callback`;
    const scope = "repo,read:packages";

    const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;

    return Response.json({ url }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/github/callback — GitHub redirects here after user authorizes */
export async function handleGitHubCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const origin = getPanelOrigin(request);

  if (!code || !state) {
    return Response.redirect(`${origin}/#/account?github=error&reason=missing_params`);
  }

  let userId: string;
  try {
    userId = await verifyStateToken(state);
  } catch {
    return Response.redirect(`${origin}/#/account?github=error&reason=invalid_state`);
  }

  try {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return Response.redirect(`${origin}/#/account?github=error&reason=not_configured`);
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    interface GitHubTokenResponse {
      access_token?: string;
      error?: string;
      error_description?: string;
    }
    interface GitHubUserResponse {
      id: number;
      login: string;
      avatar_url: string;
    }
    const tokenData = await tokenRes.json() as GitHubTokenResponse;
    if (tokenData.error || !tokenData.access_token) {
      log("callback", `Token exchange failed: ${tokenData.error_description || tokenData.error}`);
      return Response.redirect(`${origin}/#/account?github=error&reason=token_exchange`);
    }

    const accessToken = tokenData.access_token;

    // Fetch GitHub user info
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!userRes.ok) {
      log("callback", `GitHub user fetch failed: ${userRes.status}`);
      return Response.redirect(`${origin}/#/account?github=error&reason=user_fetch`);
    }

    const ghUser = await userRes.json() as GitHubUserResponse;
    const githubId = ghUser.id;
    const githubUsername = ghUser.login;
    const avatarUrl = ghUser.avatar_url;

    // Store encrypted token and update user
    await secretStore.set(`github_oauth:${userId}`, accessToken);
    db.updateUserGitHub(userId, githubId, githubUsername, avatarUrl);

    log("callback", `Linked GitHub account @${githubUsername} to user ${userId}`);
    return Response.redirect(`${origin}/#/account?github=linked`);
  } catch (err) {
    log("callback", `Error:`, err);
    return Response.redirect(`${origin}/#/account?github=error&reason=internal`);
  }
}

/** POST /api/auth/github/unlink — remove GitHub link from current user */
export async function handleGitHubUnlink(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    await secretStore.delete(`github_oauth:${userId}`);
    db.clearUserGitHub(userId);

    log("unlink", `Unlinked GitHub from user ${userId}`);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/github/status — check if current user has GitHub linked */
export async function handleGitHubStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);

    return Response.json(
      {
        linked: !!user?.github_id,
        githubUsername: user?.github_username || "",
        avatarUrl: user?.github_avatar_url || "",
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
