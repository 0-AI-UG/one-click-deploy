import { corsHeaders } from "../lib/cors.ts";
import { createTempToken } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { secretStore } from "../../bun/secret-store.ts";
import { validateHetznerToken, validateGitHubPat } from "../../bun/validate.ts";

export function isSetupComplete(): boolean {
  return db.getUserCount() > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  return Response.json(
    { setupComplete: isSetupComplete() },
    { headers: corsHeaders },
  );
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
    const { email, password, hetzner_api_token, hetzner_dns_token, github_pat, dns_zone_id, default_server_type, default_location } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (!hetzner_api_token) {
      return Response.json(
        { error: "Hetzner API token is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Validate tokens
    const hetznerValidation = validateHetznerToken(hetzner_api_token);
    if (!hetznerValidation.valid) {
      return Response.json(
        { error: `Hetzner API token: ${hetznerValidation.error}` },
        { status: 400, headers: corsHeaders },
      );
    }

    if (github_pat) {
      const patValidation = validateGitHubPat(github_pat);
      if (!patValidation.valid) {
        return Response.json(
          { error: `GitHub token: ${patValidation.error}` },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    // Create admin user
    const userId = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.insertUser({ id: userId, email, password_hash: passwordHash, is_admin: true });

    // Store secrets
    await secretStore.set("hetzner_api_token", hetzner_api_token);
    if (hetzner_dns_token) await secretStore.set("hetzner_dns_token", hetzner_dns_token);
    if (github_pat) await secretStore.set("github_pat", github_pat);

    // Store non-secret settings
    if (dns_zone_id) db.saveSetting("dns_zone_id", dns_zone_id);
    if (default_server_type) db.saveSetting("default_server_type", default_server_type);
    if (default_location) db.saveSetting("default_location", default_location);

    // Return temp token for mandatory 2FA setup
    const tempToken = await createTempToken(userId);

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, email } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
