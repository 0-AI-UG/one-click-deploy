import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { getInfrastructureToken, secretStore, maskToken } from "../../shared/secret-store.ts";
import { assignedProvider } from "../../shared/provider-connections.ts";
import { defaultInfrastructureProvider } from "../../shared/infrastructure.ts";

const PLAIN_SETTING_KEYS = new Set([
  "github_oauth_client_id",
  "default_server_type",
  "default_location",
  "oci_artifact_ref",
  "oci_registry_username",
  "github_build_username",
  "github_build_host",
]);

export async function handleGetSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const s = db.getSettings();
    const githubOauthClientSecret = await secretStore.get("github_oauth_client_secret");
    const registryPassword = await secretStore.get("oci_registry_password");
    const githubBuildToken = await secretStore.get("github_build_token");
    return Response.json(
      {
        github_oauth_client_id: s.github_oauth_client_id ?? "",
        github_oauth_client_secret: maskToken(githubOauthClientSecret ?? ""),
        infrastructure_provider: (() => {
          const connection = assignedProvider("infrastructure", s);
          const adapter = defaultInfrastructureProvider(s);
          return connection && adapter?.capabilities.compute
            ? { id: connection.id, name: connection.name } : null;
        })(),
        default_domain_suffix: s.default_domain_suffix ?? "",
        default_server_type: s.default_server_type ?? "",
        default_location: s.default_location ?? "",
        oci_artifact_ref: s.oci_artifact_ref ?? "",
        oci_registry_username: s.oci_registry_username ?? "",
        oci_registry_password: maskToken(registryPassword ?? ""),
        github_build_username: s.github_build_username ?? (githubBuildToken ? "x-access-token" : ""),
        github_build_host: s.github_build_host ?? (githubBuildToken ? "github.com" : ""),
        github_build_token: maskToken(githubBuildToken ?? ""),
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
    const compute = defaultInfrastructureProvider(db.getSettings());
    if (!compute?.capabilities.compute) return Response.json({ server_types: [] }, { headers: corsHeaders });
    const token = await getInfrastructureToken(compute.id);
    if (!token) return Response.json({ server_types: [] }, { headers: corsHeaders });
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

    if ("infrastructure_provider_id" in settings &&
        settings.infrastructure_provider_id !== (assignedProvider("infrastructure")?.id ?? "")) {
      return Response.json({ error: "Infrastructure provider changed. Reload settings before saving." }, { status: 409, headers: corsHeaders });
    }

    for (const [key, rawValue] of Object.entries(settings)) {
      if (key === "infrastructure_provider_id") continue;
      if (key === "require_2fa") {
        db.saveSetting(key, rawValue ? "1" : "0");
        continue;
      }
      const value = String(rawValue ?? "");
      if (key === "oci_artifact_ref" && value &&
          !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?$/i.test(value)) {
        return Response.json(
          { error: `${key} must be an OCI repository reference` },
          { status: 400, headers: corsHeaders },
        );
      }
      if (key === "github_build_username" && value && !/^[^\s]{1,100}$/.test(value)) {
        return Response.json(
          { error: "github_build_username must be a single non-whitespace token" },
          { status: 400, headers: corsHeaders },
        );
      }
      if (key === "default_domain_suffix") {
        const suffix = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
        if (suffix && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(suffix)) {
          return Response.json(
            { error: "default_domain_suffix must be a valid DNS suffix such as apps.example.com" },
            { status: 400, headers: corsHeaders },
          );
        }
        db.saveSetting(key, suffix);
      } else if (key === "github_oauth_client_secret") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          await secretStore.set(key, value);
        } else {
          await secretStore.delete(key);
        }
      } else if (key === "oci_registry_password" || key === "github_build_token") {
        if (value.includes("...") || value === "****") continue;
        if (value) await secretStore.set(key, value);
        else await secretStore.delete(key);
      } else if (PLAIN_SETTING_KEYS.has(key)) {
        db.saveSetting(key, value);
      } else {
        return Response.json(
          { error: `Unknown setting: ${key}` },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
