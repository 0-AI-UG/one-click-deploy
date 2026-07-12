import { corsHeaders } from "../lib/cors.ts";
import { createTempToken } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { syncZoneNameSetting } from "../../shared/dns-zone.ts";

export function isSetupComplete(): boolean {
  return db.getUserCount() > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  // If the panel was handed off from an auto-deploy run, the provider token
  // is already present — the wizard should skip the token step and only
  // prompt for the admin account.
  const provider = hetzner;
  const existingToken = await secretStore.get(provider.tokenKey).catch(() => null);
  return Response.json(
    {
      setupComplete: isSetupComplete(),
      hasProviderToken: !!existingToken,
      provider: { id: provider.id, name: provider.name },
    },
    { headers: corsHeaders },
  );
}

export async function handleSetupServerTypes(request: Request): Promise<Response> {
  try {
    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders },
      );
    }
    const body = await request.json() as { provider_token?: string };
    const token = body.provider_token?.trim();
    if (!token) {
      return Response.json({ server_types: [] }, { headers: corsHeaders });
    }
    const provider = hetzner;
    const validation = provider.validateToken(token);
    if (!validation.valid) {
      return Response.json(
        { error: `${provider.name} API token: ${validation.error}` },
        { status: 400, headers: corsHeaders },
      );
    }
    try {
      await provider.verifyToken(token);
    } catch (err) {
      return Response.json(
        { error: (err as Error).message },
        { status: 400, headers: corsHeaders },
      );
    }
    // Persist the token temporarily so the provider's listServerTypes() can
    // authenticate. The setup flow is single-user pre-admin; overwriting is
    // safe because handleSetupComplete will re-write the final value.
    await secretStore.set(provider.tokenKey, token);
    const types = await provider.listServerTypes();
    return Response.json({ server_types: types }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSetupComplete(request: Request): Promise<Response> {
  try {
    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders },
      );
    }

    const body = await request.json() as Record<string, string>;
    const { username, password, provider_token, dns_zone_id, default_server_type, default_location } = body;

    if (!username || !password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const provider = hetzner;

    // Allow skipping the provider token if one is already present (e.g.
    // after a self-deploy handoff from a bootstrap instance).
    const existingToken = await secretStore.get(provider.tokenKey).catch(() => null);
    if (!provider_token && !existingToken) {
      return Response.json(
        { error: `${provider.name} API token is required` },
        { status: 400, headers: corsHeaders },
      );
    }

    if (provider_token) {
      const validation = provider.validateToken(provider_token);
      if (!validation.valid) {
        return Response.json(
          { error: `${provider.name} API token: ${validation.error}` },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    // Create admin user
    const userId = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.insertUser({ id: userId, username, password_hash: passwordHash, is_admin: true });

    // Store secrets (only overwrite provider token if a new one was given)
    if (provider_token) await secretStore.set(provider.tokenKey, provider_token);

    // Store non-secret settings
    if (dns_zone_id) {
      db.saveSetting("dns_zone_id", dns_zone_id);
      // Cache the zone name for auto-domains (<app>.<zone>).
      await syncZoneNameSetting(dns_zone_id);
    }
    if (default_server_type) db.saveSetting("default_server_type", default_server_type);
    if (default_location) db.saveSetting("default_location", default_location);

    // Return temp token for mandatory 2FA setup
    const createdUser = db.getUserById(userId)!;
    const tempToken = await createTempToken(userId, createdUser.token_version);

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, username } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
