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
import { generateBackupCodes } from "./totp.ts";
import * as db from "../../bun/db.ts";

// --- Challenge store (in-memory, single-process) ---

const challenges = new Map<string, { challenge: string; expiresAt: number }>();

function setChallenge(userId: string, challenge: string) {
  challenges.set(userId, { challenge, expiresAt: Date.now() + 60_000 });
}

function getAndDeleteChallenge(userId: string): string | null {
  const entry = challenges.get(userId);
  challenges.delete(userId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// --- RP config ---

function getRpConfig(request: Request) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  // Behind a TLS-terminating reverse proxy (Caddy), request.url is http://
  // but the browser's actual origin is https://. Use the Origin header when
  // available, otherwise infer from X-Forwarded-Proto or default to https.
  const browserOrigin =
    process.env.WEBAUTHN_ORIGIN ||
    request.headers.get("Origin") ||
    `${request.headers.get("X-Forwarded-Proto") || "https"}://${hostname}`;
  return {
    rpName: "OneClickDeploy",
    rpID: process.env.WEBAUTHN_RP_ID || hostname,
    origin: browserOrigin,
  };
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
    totpEnabled: user.totp_enabled === 1,
    webauthnEnabled: user.webauthn_enabled === 1,
    githubLinked: !!user.github_id,
    githubUsername: user.github_username || "",
    githubAvatarUrl: user.github_avatar_url || "",
    permissions,
  };
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

    const options = await generateRegistrationOptions({
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

    setChallenge(userId, options.challenge);
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

    const challenge = getAndDeleteChallenge(userId);
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    db.insertWebAuthnCredential({
      id: credential.id,
      userId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: body.credential.response.transports ?? [],
      name: body.name || "Passkey",
    });
    db.enableWebAuthn(userId);

    // Generate backup codes if this is the user's first 2FA method
    const isFirst2FA = !user.totp_enabled && db.getUnusedBackupCodeCount(userId) === 0;
    let backupCodes: string[] | undefined;
    if (isFirst2FA) {
      backupCodes = generateBackupCodes(8);
      const codeHashes = await Promise.all(
        backupCodes.map((code) => Bun.password.hash(code.replace("-", ""), "bcrypt")),
      );
      db.insertBackupCodes(userId, codeHashes);
    }

    return Response.json({ verified: true, backupCodes }, { headers: corsHeaders });
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

    const options = await generateRegistrationOptions({
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

    setChallenge(userId, options.challenge);
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

    const challenge = getAndDeleteChallenge(userId);
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    db.insertWebAuthnCredential({
      id: credential.id,
      userId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: body.credential.response.transports ?? [],
      name: body.name || "Passkey",
    });
    db.enableWebAuthn(userId);

    // Generate backup codes
    const backupCodes = generateBackupCodes(8);
    const codeHashes = await Promise.all(
      backupCodes.map((code) => Bun.password.hash(code.replace("-", ""), "bcrypt")),
    );
    db.insertBackupCodes(userId, codeHashes);

    // Issue real JWT
    const token = await createToken({ userId: user.id, username: user.username });

    return Response.json(
      { token, user: userResponse(db.getUserById(userId)!), backupCodes },
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

    setChallenge(userId, options.challenge);
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

    const challenge = getAndDeleteChallenge(userId);
    if (!challenge) {
      return Response.json({ error: "Challenge expired. Please try again." }, { status: 400, headers: corsHeaders });
    }

    const storedCredential = db.getWebAuthnCredentialById(body.credential.id);
    if (!storedCredential || storedCredential.user_id !== userId) {
      return Response.json({ error: "Unknown credential" }, { status: 400, headers: corsHeaders });
    }

    const rp = getRpConfig(request);
    const verification = await verifyAuthenticationResponse({
      response: body.credential,
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

    if (!verification.verified) {
      return Response.json({ error: "Verification failed" }, { status: 400, headers: corsHeaders });
    }

    db.updateWebAuthnCounter(storedCredential.id, verification.authenticationInfo.newCounter);

    const token = await createToken({ userId: user.id, username: user.username });
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
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { username?: string };
    // Return generic error for all failure cases to avoid leaking info
    const genericError = Response.json(
      { error: "Unable to initiate passkey verification. Check your username." },
      { status: 400, headers: corsHeaders },
    );
    if (!body.username) return genericError;

    const user = db.getUserByUsername(body.username);
    if (!user || !user.webauthn_enabled) return genericError;

    const credentials = db.getWebAuthnCredentials(user.id);
    if (credentials.length === 0) return genericError;

    const rp = getRpConfig(request);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "preferred",
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        transports: credentialTransports(c),
      })),
    });

    setChallenge(user.id, options.challenge);
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/password-reset/webauthn-verify */
export async function handlePasswordResetWebAuthnVerify(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

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

    const user = db.getUserByUsername(body.username);
    if (!user || !user.webauthn_enabled) return genericError;

    const challenge = getAndDeleteChallenge(user.id);
    if (!challenge) {
      return Response.json(
        { error: "Challenge expired. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const storedCredential = db.getWebAuthnCredentialById(body.credential.id);
    if (!storedCredential || storedCredential.user_id !== user.id) return genericError;

    const rp = getRpConfig(request);
    const verification = await verifyAuthenticationResponse({
      response: body.credential,
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

    if (!verification.verified) return genericError;

    db.updateWebAuthnCounter(storedCredential.id, verification.authenticationInfo.newCounter);

    const hash = await Bun.password.hash(body.newPassword, "bcrypt");
    db.updateUserPassword(user.id, hash);

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
    const wouldHave2FA = user.totp_enabled || credCount > 1;
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

    return Response.json({ deleted: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
