import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest, createToken, createTempToken, verifyTempToken } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { handleError, getClientIP } from "../lib/utils.ts";
import { authRateLimiter } from "../lib/rate-limit.ts";
import * as db from "../../shared/db.ts";
import { saveChallenge, fetchAndDeleteChallenge } from "../../shared/db/webauthn-challenges.ts";

// --- RP config ---

function getRpConfig(request: Request) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  // Behind a TLS-terminating reverse proxy (Traefik), request.url is http://
  // but the browser's actual origin is https://. Use the Origin header when
  // available, otherwise infer from X-Forwarded-Proto or default to https.
  const browserOrigin =
    process.env.WEBAUTHN_ORIGIN ||
    request.headers.get("Origin") ||
    `${request.headers.get("X-Forwarded-Proto") || "https"}://${hostname}`;
  return {
    rpName: "Open CLI Deployment",
    rpID: process.env.WEBAUTHN_RP_ID || hostname,
    origin: browserOrigin,
  };
}

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

function checkRateLimit(request: Request): Response | null {
  return checkRateLimitKeys(rateLimitKeys(request));
}

function recordFailureKeys(keys: string[]): void {
  for (const key of keys) authRateLimiter.recordFailure(key);
}

function recordFailure(request: Request): void {
  recordFailureKeys(rateLimitKeys(request));
}

function credentialTransports(c: db.WebAuthnCredential): AuthenticatorTransportFuture[] {
  try {
    return JSON.parse(c.transports) as AuthenticatorTransportFuture[];
  } catch {
    return [];
  }
}

/** Build the user response object consistently */
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

type RpConfig = ReturnType<typeof getRpConfig>;

/** Generate registration options shared by both register flows */
function buildRegistrationOptions(rp: RpConfig, user: db.UserRow, existing: db.WebAuthnCredential[]) {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.username,
    userDisplayName: user.username,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: credentialTransports(c),
    })),
  });
}

/**
 * Verify a registration response and, if valid, persist the credential and
 * enable WebAuthn for the user. Returns whether verification succeeded so the
 * caller can record failures against its own rate-limit keys.
 */
async function verifyAndStoreRegistration(
  rp: RpConfig,
  challenge: string,
  userId: string,
  credential: RegistrationResponseJSON,
  name?: string,
): Promise<boolean> {
  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });

  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential: verifiedCredential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  db.insertWebAuthnCredential({
    id: verifiedCredential.id,
    userId,
    publicKey: verifiedCredential.publicKey,
    counter: verifiedCredential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: credential.response.transports ?? [],
    name: name || "Passkey",
  });
  db.enableWebAuthn(userId);
  return true;
}

/**
 * Run authentication verification against a stored credential. Returns the raw
 * (unverified) result so each caller records failure against its own keys.
 */
function verifyStoredAuthentication(
  rp: RpConfig,
  challenge: string,
  credential: AuthenticationResponseJSON,
  storedCredential: db.WebAuthnCredential,
) {
  return verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: storedCredential.id,
      publicKey: new Uint8Array(storedCredential.public_key),
      counter: storedCredential.counter,
      transports: credentialTransports(storedCredential),
    },
  });
}

// ────────────────────────────────────────────────────
// Registration (authenticated user adding a passkey)
// ────────────────────────────────────────────────────

/** POST /api/auth/webauthn/register-options */
export async function handleWebAuthnRegisterOptions(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const existing = db.getWebAuthnCredentials(userId);
    const rp = getRpConfig(request);

    const options = await buildRegistrationOptions(rp, user, existing);

    saveChallenge(userId, options.challenge, "register");
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/webauthn/register-verify */
export async function handleWebAuthnRegisterVerify(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as { credential: RegistrationResponseJSON; name?: string };
    if (!body.credential) {
      return Response.json({ error: "credential is required" }, { status: 400, headers: corsHeaders });
    }

    const challenge = fetchAndDeleteChallenge(userId, "register");
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verified = await verifyAndStoreRegistration(rp, challenge, userId, body.credential, body.name);
    if (!verified) {
      recordFailure(request);
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    return Response.json({ verified: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// ────────────────────────────────────────────────────
// Registration during first login (temp token flow)
// ────────────────────────────────────────────────────

/** POST /api/auth/webauthn/register-options-from-login */
export async function handleWebAuthnRegisterOptionsFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string };
    if (!body.tempToken) {
      return Response.json({ error: "tempToken is required" }, { status: 400, headers: corsHeaders });
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const existing = db.getWebAuthnCredentials(userId);
    const rp = getRpConfig(request);

    const options = await buildRegistrationOptions(rp, user, existing);

    saveChallenge(userId, options.challenge, "register_from_login");
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/webauthn/register-verify-from-login */
export async function handleWebAuthnRegisterVerifyFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; credential?: RegistrationResponseJSON; name?: string };
    if (!body.tempToken || !body.credential) {
      return Response.json({ error: "tempToken and credential are required" }, { status: 400, headers: corsHeaders });
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const challenge = fetchAndDeleteChallenge(userId, "register_from_login");
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verified = await verifyAndStoreRegistration(rp, challenge, userId, body.credential, body.name);
    if (!verified) {
      recordFailure(request);
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    db.incrementTokenVersion(userId);
    const freshUser = db.getUserById(userId)!;

    // Issue real JWT
    const token = await createToken({ userId: freshUser.id, username: freshUser.username, v: freshUser.token_version });

    return Response.json(
      { token, user: userResponse(freshUser) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// ────────────────────────────────────────────────────
// Authentication (login verification)
// ────────────────────────────────────────────────────

/** POST /api/auth/webauthn/login-options */
export async function handleWebAuthnLoginOptions(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string };
    if (!body.tempToken) {
      return Response.json({ error: "tempToken is required" }, { status: 400, headers: corsHeaders });
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const credentials = db.getWebAuthnCredentials(userId);
    const rp = getRpConfig(request);

    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "preferred",
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        transports: credentialTransports(c),
      })),
    });

    saveChallenge(userId, options.challenge, "login");
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/webauthn/login-verify */
export async function handleWebAuthnLoginVerify(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; credential?: AuthenticationResponseJSON };
    if (!body.tempToken || !body.credential) {
      return Response.json({ error: "tempToken and credential are required" }, { status: 400, headers: corsHeaders });
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const challenge = fetchAndDeleteChallenge(userId, "login");
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const storedCredential = db.getWebAuthnCredentialById(body.credential.id);
    if (!storedCredential || storedCredential.user_id !== userId) {
      recordFailure(request);
      return Response.json({ error: "Unknown credential" }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verification = await verifyStoredAuthentication(rp, challenge, body.credential, storedCredential);

    if (!verification.verified) {
      recordFailure(request);
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    db.updateWebAuthnCounter(storedCredential.id, verification.authenticationInfo.newCounter);

    const token = await createToken({ userId: user.id, username: user.username, v: user.token_version });
    return Response.json(
      { token, user: userResponse(user) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// ────────────────────────────────────────────────────
// Password reset via passkey (unauthenticated)
// ────────────────────────────────────────────────────

/** POST /api/auth/password-reset/webauthn-options */
export async function handlePasswordResetWebAuthnOptions(request: Request): Promise<Response> {
  // Initial IP-only check; we need the username for full dual-key check
  const ipOnlyResp = checkRateLimit(request);
  if (ipOnlyResp) return ipOnlyResp;

  try {
    const body = await request.json() as { username?: string };
    // Return generic error for all failure cases to avoid leaking info
    const genericError = Response.json(
      { error: "Unable to initiate passkey verification. Check your username." },
      { status: 400, headers: corsHeaders },
    );

    const ipKeys = rateLimitKeys(request);
    if (!body.username) {
      recordFailureKeys(ipKeys);
      return genericError;
    }

    const keys = rateLimitKeys(request, body.username);
    const rateLimitResponse = checkRateLimitKeys(keys);
    if (rateLimitResponse) return rateLimitResponse;

    const user = db.getUserByUsername(body.username);
    if (!user || !user.webauthn_enabled) {
      recordFailureKeys(keys);
      return genericError;
    }

    const credentials = db.getWebAuthnCredentials(user.id);
    if (credentials.length === 0) {
      recordFailureKeys(keys);
      return genericError;
    }

    const rp = getRpConfig(request);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "preferred",
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        transports: credentialTransports(c),
      })),
    });

    saveChallenge(user.id, options.challenge, "password_reset");
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/password-reset/webauthn-verify */
export async function handlePasswordResetWebAuthnVerify(request: Request): Promise<Response> {
  // Initial IP-only check; full dual-key check happens after parsing username
  const ipOnlyResp = checkRateLimit(request);
  if (ipOnlyResp) return ipOnlyResp;

  try {
    const body = await request.json() as {
      username?: string;
      credential?: AuthenticationResponseJSON;
      newPassword?: string;
    };
    const genericError = Response.json(
      { error: "Unable to reset password. Passkey verification failed." },
      { status: 400, headers: corsHeaders },
    );
    if (!body.username || !body.credential || !body.newPassword) {
      return Response.json(
        { error: "Username, passkey credential, and new password are required" },
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
    if (!user || !user.webauthn_enabled) {
      recordFailureKeys(keys);
      return genericError;
    }

    const challenge = fetchAndDeleteChallenge(user.id, "password_reset");
    if (!challenge) {
      return Response.json(
        { error: "Challenge expired. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const storedCredential = db.getWebAuthnCredentialById(body.credential.id);
    if (!storedCredential || storedCredential.user_id !== user.id) {
      recordFailureKeys(keys);
      return genericError;
    }

    const rp = getRpConfig(request);
    const verification = await verifyStoredAuthentication(rp, challenge, body.credential, storedCredential);

    if (!verification.verified) {
      recordFailureKeys(keys);
      return genericError;
    }

    db.updateWebAuthnCounter(storedCredential.id, verification.authenticationInfo.newCounter);

    const hash = await Bun.password.hash(body.newPassword, "bcrypt");
    db.updateUserPassword(user.id, hash);
    db.incrementTokenVersion(user.id);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// ────────────────────────────────────────────────────
// Credential management
// ────────────────────────────────────────────────────

/** GET /api/auth/webauthn/credentials */
export async function handleWebAuthnList(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const credentials = db.getWebAuthnCredentials(userId);

    return Response.json(
      credentials.map((c) => ({
        id: c.id,
        name: c.name,
        deviceType: c.device_type,
        backedUp: c.backed_up === 1,
        createdAt: c.created_at,
      })),
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/webauthn/delete */
export async function handleWebAuthnDelete(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = db.getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as { credentialId?: string };
    if (!body.credentialId) {
      return Response.json({ error: "credentialId is required" }, { status: 400, headers: corsHeaders });
    }

    const credential = db.getWebAuthnCredentialById(body.credentialId);
    if (!credential || credential.user_id !== userId) {
      return Response.json({ error: "Credential not found" }, { status: 404, headers: corsHeaders });
    }

    // Check if this would leave the user with no 2FA when required
    const credCount = db.getWebAuthnCredentialCount(userId);
    const wouldHave2FA = credCount > 1;
    const require2fa = (db.getSettings().require_2fa ?? "1") === "1";
    if (!wouldHave2FA && (user.is_admin || require2fa)) {
      return Response.json(
        { error: "Cannot remove last passkey: at least one 2FA method is required" },
        { status: 403, headers: corsHeaders },
      );
    }

    db.deleteWebAuthnCredential(body.credentialId);

    if (db.getWebAuthnCredentialCount(userId) === 0) {
      db.disableWebAuthn(userId);
    }

    db.incrementTokenVersion(userId);
    const freshUser = db.getUserById(userId)!;
    const token = await createToken({ userId: freshUser.id, username: freshUser.username, v: freshUser.token_version });

    return Response.json({ deleted: true, token }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
