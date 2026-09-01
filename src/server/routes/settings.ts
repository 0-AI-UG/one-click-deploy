import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { secretStore, maskToken } from "../../shared/secret-store.ts";
import { hetzner } from "../../shared/providers/index.ts";
import {
  HETZNER_S3_ACCESS_KEY,
  HETZNER_S3_REGION_SETTING,
  HETZNER_S3_REGIONS,
  HETZNER_S3_SECRET_KEY,
  isHetznerS3Region,
  listBuckets,
} from "../../engine/hetzner/s3.ts";

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
    const providerToken = await secretStore.getProviderToken();
    const githubOauthClientSecret = await secretStore.get("github_oauth_client_secret");
    const registryPassword = await secretStore.get("oci_registry_password");
    const githubBuildToken = await secretStore.get("github_build_token");
    const s3AccessKey = await secretStore.get(HETZNER_S3_ACCESS_KEY);
    const s3SecretKey = await secretStore.get(HETZNER_S3_SECRET_KEY);
    return Response.json(
      {
        hetzner_api_token: maskToken(providerToken),
        hetzner_configured: !!providerToken,
        hetzner_s3_access_key: maskToken(s3AccessKey ?? ""),
        hetzner_s3_secret_key: maskToken(s3SecretKey ?? ""),
        hetzner_s3_region: s[HETZNER_S3_REGION_SETTING] || "fsn1",
        hetzner_s3_configured: !!s3AccessKey && !!s3SecretKey,
        hetzner_s3_regions: HETZNER_S3_REGIONS,
        github_oauth_client_id: s.github_oauth_client_id ?? "",
        github_oauth_client_secret: maskToken(githubOauthClientSecret ?? ""),
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
    const compute = hetzner;
    const token = await secretStore.get(compute.tokenKey);
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

    const provider = hetzner;
    const s3SettingKeys = new Set([
      HETZNER_S3_ACCESS_KEY,
      HETZNER_S3_SECRET_KEY,
      HETZNER_S3_REGION_SETTING,
    ]);
    const hasS3Settings = [...s3SettingKeys].some((key) => Object.hasOwn(settings, key));
    if (hasS3Settings) {
      const current = db.getSettings();
      const [currentAccessKey, currentSecretKey] = await Promise.all([
        secretStore.get(HETZNER_S3_ACCESS_KEY),
        secretStore.get(HETZNER_S3_SECRET_KEY),
      ]);
      const submittedAccessKey = String(settings[HETZNER_S3_ACCESS_KEY] ?? "").trim();
      const submittedSecretKey = String(settings[HETZNER_S3_SECRET_KEY] ?? "").trim();
      const isMasked = (value: string) => value === "****" || value.includes("...");
      const accessKey = isMasked(submittedAccessKey) ? currentAccessKey ?? "" : submittedAccessKey;
      const secretKey = isMasked(submittedSecretKey) ? currentSecretKey ?? "" : submittedSecretKey;
      const rawRegion = String(
        settings[HETZNER_S3_REGION_SETTING] ?? current[HETZNER_S3_REGION_SETTING] ?? "fsn1",
      ).trim();
      if (!isHetznerS3Region(rawRegion)) {
        return Response.json(
          { error: `hetzner_s3_region must be one of ${HETZNER_S3_REGIONS.join(", ")}` },
          { status: 400, headers: corsHeaders },
        );
      }
      if (!!accessKey !== !!secretKey) {
        return Response.json(
          { error: "Both the Hetzner S3 access key and secret key are required" },
          { status: 400, headers: corsHeaders },
        );
      }
      const credentialsChanged =
        (!isMasked(submittedAccessKey) && submittedAccessKey !== (currentAccessKey ?? "")) ||
        (!isMasked(submittedSecretKey) && submittedSecretKey !== (currentSecretKey ?? "")) ||
        rawRegion !== (current[HETZNER_S3_REGION_SETTING] || "fsn1");
      if (accessKey && secretKey && credentialsChanged) {
        try {
          await listBuckets({ accessKey, secretKey, region: rawRegion });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Could not verify Hetzner S3 credentials" },
            { status: 400, headers: corsHeaders },
          );
        }
      }
      if (accessKey && secretKey) {
        await secretStore.set(HETZNER_S3_ACCESS_KEY, accessKey);
        await secretStore.set(HETZNER_S3_SECRET_KEY, secretKey);
      } else {
        await secretStore.delete(HETZNER_S3_ACCESS_KEY);
        await secretStore.delete(HETZNER_S3_SECRET_KEY);
      }
      db.saveSetting(HETZNER_S3_REGION_SETTING, rawRegion);
    }
    for (const [key, rawValue] of Object.entries(settings)) {
      if (s3SettingKeys.has(key)) continue;
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
      if (key === "hetzner_api_token") {
        if (value.includes("...") || value === "****") continue;
        if (value) {
          const validation = provider.validateToken(value);
          if (!validation.valid) {
            return Response.json(
              { error: `${provider.name} API token: ${validation.error}` },
              { status: 400, headers: corsHeaders },
            );
          }
          await provider.verifyToken(value);
          await secretStore.set(provider.tokenKey, value);
        } else await secretStore.delete(provider.tokenKey);
      } else if (key === "default_domain_suffix") {
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
