import { corsHeaders } from "../lib/cors.ts";
import { createTempToken } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { secretStore } from "../../bun/secret-store.ts";
import { validateHetznerToken } from "../../bun/validate.ts";

export function isSetupComplete(): boolean {
  return db.getUserCount() > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  // If the panel was handed off from an auto-deploy run, the Hetzner token
  // is already present — the wizard should skip the token step and only
  // prompt for the admin account.
  const hetznerToken = await secretStore.get("hetzner_api_token").catch(() => null);
  return Response.json(
    {
      setupComplete: isSetupComplete(),
      hasHetznerToken: !!hetznerToken,
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
    const body = await request.json() as { hetzner_api_token?: string };
    const token = body.hetzner_api_token?.trim();
    if (!token) {
      return Response.json({ server_types: [] }, { headers: corsHeaders });
    }
    const validation = validateHetznerToken(token);
    if (!validation.valid) {
      return Response.json(
        { error: `Hetzner API token: ${validation.error}` },
        { status: 400, headers: corsHeaders },
      );
    }
    const res = await fetch("https://api.hetzner.cloud/v1/server_types?per_page=50", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return Response.json(
        { error: res.status === 401 ? "Invalid Hetzner API token" : `Hetzner API error (${res.status})` },
        { status: 400, headers: corsHeaders },
      );
    }
    const data = await res.json() as any;
    const types: Array<{ name: string; description: string; cores: number; memory: number; disk: number; locations: string[] }> = [];
    for (const t of data.server_types ?? []) {
      if (t.deprecation?.announced) continue;
      types.push({
        name: t.name,
        description: t.description,
        cores: t.cores,
        memory: t.memory,
        disk: t.disk,
        locations: (t.prices ?? []).map((p: any) => p.location),
      });
    }
    types.sort((a, b) => a.memory - b.memory || a.cores - b.cores);
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
    const { username, password, hetzner_api_token, dns_zone_id, default_server_type, default_location } = body;

    if (!username || !password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Allow skipping the Hetzner token if one is already present (e.g. after
    // a self-deploy handoff from a bootstrap instance).
    const existingToken = await secretStore.get("hetzner_api_token").catch(() => null);
    if (!hetzner_api_token && !existingToken) {
      return Response.json(
        { error: "Hetzner API token is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (hetzner_api_token) {
      const hetznerValidation = validateHetznerToken(hetzner_api_token);
      if (!hetznerValidation.valid) {
        return Response.json(
          { error: `Hetzner API token: ${hetznerValidation.error}` },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    // Create admin user
    const userId = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.insertUser({ id: userId, username, password_hash: passwordHash, is_admin: true });

    // Store secrets (only overwrite Hetzner token if a new one was given)
    if (hetzner_api_token) await secretStore.set("hetzner_api_token", hetzner_api_token);

    // Store non-secret settings
    if (dns_zone_id) db.saveSetting("dns_zone_id", dns_zone_id);
    if (default_server_type) db.saveSetting("default_server_type", default_server_type);
    if (default_location) db.saveSetting("default_location", default_location);

    // Return temp token for mandatory 2FA setup
    const tempToken = await createTempToken(userId);

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, username } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
