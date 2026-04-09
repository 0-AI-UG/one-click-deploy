import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { secretStore, maskToken } from "../../bun/secret-store.ts";
import { validateHetznerToken, validateGitHubPat } from "../../bun/validate.ts";
import { hetznerApi } from "../../bun/hetzner/api.ts";

export async function handleGetSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const s = db.getSettings();
    const tokens = await secretStore.getTokens();
    return Response.json(
      {
        hetzner_api_token: maskToken(tokens.hetzner_api_token),
        github_pat: maskToken(tokens.github_pat),
        dns_zone_id: s.dns_zone_id ?? "",
        default_server_type: s.default_server_type ?? "",
        default_location: s.default_location ?? "",
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
    const data = await hetznerApi("/server_types?per_page=50");
    const types: Array<{ name: string; description: string; cores: number; memory: number; disk: number; locations: string[] }> = [];
    for (const t of data.server_types ?? []) {
      // Only include shared vCPU types (cpx/cx/cax) that aren't deprecated globally
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
    // Sort by memory then cores
    types.sort((a, b) => a.memory - b.memory || a.cores - b.cores);
    return Response.json({ server_types: types }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSaveSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const settings = await request.json() as Record<string, unknown>;

    for (const [key, rawValue] of Object.entries(settings)) {
      if (key === "require_2fa") {
        db.saveSetting(key, rawValue ? "1" : "0");
        continue;
      }
      const value = String(rawValue ?? "");
      if (key === "hetzner_api_token") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          const validation = validateHetznerToken(value);
          if (!validation.valid) {
            return Response.json(
              { error: `${key}: ${validation.error}` },
              { status: 400, headers: corsHeaders },
            );
          }
          await secretStore.set(key, value);
        }
      } else if (key === "github_pat") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          const validation = validateGitHubPat(value);
          if (!validation.valid) {
            return Response.json(
              { error: `GitHub token: ${validation.error}` },
              { status: 400, headers: corsHeaders },
            );
          }
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
