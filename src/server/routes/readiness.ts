import { inspectDeployReadiness } from "../../engine/readiness.ts";
import { normalizeRegistryScope } from "../../engine/registry-config.ts";
import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin, requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { maskToken, secretStore } from "../../shared/secret-store.ts";

export async function handleGetReadiness(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const url = new URL(request.url);
    const readiness = await inspectDeployReadiness({
      repository: url.searchParams.get("repository") || undefined,
      image: url.searchParams.get("image") || undefined,
    });
    return Response.json(readiness, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetConnections(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const settings = db.getSettings();
    const registryToken = await secretStore.get("oci_registry_password");
    const sourceToken = await secretStore.get("github_build_token");
    return Response.json({
      registry: {
        connected: !!(settings.oci_artifact_ref && settings.oci_registry_username && registryToken),
        scope: settings.oci_artifact_ref || "",
        username: settings.oci_registry_username || "",
        token: maskToken(registryToken || ""),
      },
      source: {
        connected: !!sourceToken,
        host: settings.github_build_host || "github.com",
        username: settings.github_build_username || "x-access-token",
        token: maskToken(sourceToken || ""),
      },
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePutRegistryConnection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as { scope?: unknown; username?: unknown; token?: unknown };
    const scope = normalizeRegistryScope(String(body.scope ?? ""));
    const username = String(body.username ?? "").trim();
    const token = String(body.token ?? "");
    if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i.test(scope)) {
      return Response.json({ error: "scope must be an OCI repository or namespace, for example ghcr.io/acme" }, { status: 400, headers: corsHeaders });
    }
    if (!username || /\s/.test(username)) {
      return Response.json({ error: "username must be a non-whitespace registry username" }, { status: 400, headers: corsHeaders });
    }
    if (!token || token.includes("...") || token === "****") {
      return Response.json({ error: "a new registry password or token is required" }, { status: 400, headers: corsHeaders });
    }
    db.saveSetting("oci_artifact_ref", scope);
    db.saveSetting("oci_registry_username", username);
    await secretStore.set("oci_registry_password", token);
    return Response.json({ ok: true, connected: true, scope, username }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteRegistryConnection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    db.saveSetting("oci_artifact_ref", "");
    db.saveSetting("oci_registry_username", "");
    await secretStore.delete("oci_registry_password");
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePutSourceConnection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as { host?: unknown; username?: unknown; token?: unknown };
    const host = String(body.host ?? "github.com").trim().toLowerCase();
    const username = String(body.username ?? "x-access-token").trim();
    const token = String(body.token ?? "");
    if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)) {
      return Response.json({ error: "host must be a Git hostname such as github.com" }, { status: 400, headers: corsHeaders });
    }
    if (!username || /\s/.test(username)) {
      return Response.json({ error: "username must be a non-whitespace Git username" }, { status: 400, headers: corsHeaders });
    }
    if (!token || token.includes("...") || token === "****") {
      return Response.json({ error: "a new source token is required" }, { status: 400, headers: corsHeaders });
    }
    db.saveSetting("github_build_host", host);
    db.saveSetting("github_build_username", username);
    await secretStore.set("github_build_token", token);
    return Response.json({ ok: true, connected: true, host, username }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteSourceConnection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    db.saveSetting("github_build_host", "github.com");
    db.saveSetting("github_build_username", "x-access-token");
    await secretStore.delete("github_build_token");
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
