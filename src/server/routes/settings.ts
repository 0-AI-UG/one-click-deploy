import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { secretStore, maskToken } from "../../shared/secret-store.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { syncZoneNameSetting } from "../../shared/dns-zone.ts";

export async function handleGetSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const s = db.getSettings();
    const providerToken = await secretStore.getProviderToken();
    const githubOauthClientSecret = await secretStore.get("github_oauth_client_secret");
    const provider = hetzner;
    return Response.json(
      {
        provider_token: maskToken(providerToken),
        provider: { id: provider.id, name: provider.name },
        github_oauth_client_id: s.github_oauth_client_id ?? "",
        github_oauth_client_secret: maskToken(githubOauthClientSecret ?? ""),
        dns_zone_id: s.dns_zone_id ?? "",
        default_server_type: s.default_server_type ?? "",
        default_location: s.default_location ?? "",
        allow_archive_image_transfer: (s.allow_archive_image_transfer ?? "0") === "1",
        require_2fa: (s.require_2fa ?? "1") === "1",
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServerTypes(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const compute = hetzner;
    const types = await compute.listServerTypes();
    return Response.json({ server_types: types }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSaveSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const settings = await request.json() as Record<string, unknown>;

    const provider = hetzner;
    for (const [key, rawValue] of Object.entries(settings)) {
      if (key === "require_2fa" || key === "allow_archive_image_transfer") {
        db.saveSetting(key, rawValue ? "1" : "0");
        continue;
      }
      const value = String(rawValue ?? "");
      if (key === "provider_token") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          const validation = provider.validateToken(value);
          if (!validation.valid) {
            return Response.json(
              { error: `${provider.name} API token: ${validation.error}` },
              { status: 400, headers: corsHeaders },
            );
          }
          await secretStore.set(provider.tokenKey, value);
        }
      } else if (key === "github_oauth_client_id") {
        db.saveSetting(key, value);
      } else if (key === "dns_zone_id") {
        db.saveSetting(key, value);
        // Cache the zone *name* for auto-domains (<app>.<zone>); an empty
        // zone id clears it.
        await syncZoneNameSetting(value);
      } else if (key === "github_oauth_client_secret") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          await secretStore.set(key, value);
        } else {
          await secretStore.delete(key);
        }
      } else {
        db.saveSetting(key, String(value));
      }
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
