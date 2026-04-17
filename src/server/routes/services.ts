import { corsHeaders } from "../lib/cors.ts";
import { requireOrgPermission } from "../lib/org-context.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars, encryptValue } from "../../shared/env-crypto.ts";
import type { EnvVarEntry } from "../../shared/env-crypto.ts";
import type { ServiceDeployRequest } from "../../engine/deploy/deploy-service.ts";
import { getServiceLogs } from "../../engine/deploy/service-lifecycle.ts";
import { getCatalogEntries, getCatalogEntry } from "../../shared/services/catalog.ts";
import { enqueue } from "../ipc/enqueue.ts";

// --- Catalog ---

export async function handleGetCatalog(_request: Request): Promise<Response> {
  try {
    const entries = getCatalogEntries().map((e) => ({
      type: e.type,
      label: e.label,
      versions: e.versions,
      defaultPort: e.defaultPort,
      requiredEnvVars: e.requiredEnvVars,
      defaultVolumeSize: e.defaultVolumeSize,
    }));
    return Response.json(entries, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetServices(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "servers.view");
    const services = db.getServices(ctx.orgId);
    const result = services.map((s) => {
      const instances = db.getServiceInstances(s.id);
      const links = db.getServiceLinks(s.id);
      return {
        ...s,
        primary_instance: instances[0] || null,
        linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name })),
      };
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Detail ---

export async function handleGetService(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "servers.view");
    const service = db.getService(serviceId, ctx.orgId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    // Join the hosting server's name onto each instance so the detail page
    // can show a meaningful "Server" column without a second fetch.
    // server_id comes from service_instances — safe to look up unscoped.
    const instances = db.getServiceInstances(serviceId).map((inst) => {
      const srv = db.getServerUnscoped(inst.server_id);
      return { ...inst, server_name: srv?.name ?? `srv#${inst.server_id}` };
    });
    const links = db.getServiceLinks(serviceId);
    return Response.json({
      ...service,
      credentials: JSON.parse(service.credentials || "{}"),
      instances,
      linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name, env_prefix: l.env_prefix })),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Deploy ---

export async function handleDeployService(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.deploy");
    const req: ServiceDeployRequest = await request.json();
    if (!req?.name || typeof req.name !== "string") {
      return Response.json({ ok: false, error: "name is required" }, { status: 400, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy_service",
      resourceKeys: [`service:create:${req.name}`],
      input: req,
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyService(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.destroy");
    if (!db.getService(serviceId, ctx.orgId)) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "destroy_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartService(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.manage");
    if (!db.getService(serviceId, ctx.orgId)) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "restart_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.manage");
    if (!db.getService(serviceId, ctx.orgId)) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "pause_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.manage");
    if (!db.getService(serviceId, ctx.orgId)) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "unpause_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Logs ---

export async function handleGetServiceLogs(request: Request, serviceId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.logs");
    if (!db.getService(serviceId, ctx.orgId)) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("instance_id")
      ? parseInt(url.searchParams.get("instance_id")!, 10)
      : undefined;
    const logs = await getServiceLogs(serviceId, instanceId);
    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Linking ---

export async function handleLinkService(request: Request, serviceId: number, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.link");
    const body = await request.json().catch(() => ({}));
    const envPrefix = body.env_prefix || "DATABASE";

    const service = db.getService(serviceId, ctx.orgId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const app = db.getApp(appId, ctx.orgId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }

    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) {
      return Response.json({ error: "Unknown service type" }, { status: 400, headers: corsHeaders });
    }

    // Parse credentials
    const credentials = JSON.parse(service.credentials || "{}");

    // Build new env var entries for the service link
    const now = new Date().toISOString();
    const newEntries: EnvVarEntry[] = [];

    // Helper: create entry, marking URL and password as secrets
    const secretKeys = new Set([`${envPrefix}_URL`, `${envPrefix}_PASSWORD`]);
    const pairs: [string, string][] = [
      [`${envPrefix}_URL`, credentials.connection_url || ""],
      [`${envPrefix}_HOST`, credentials.host || ""],
      [`${envPrefix}_PORT`, String(credentials.port || "")],
    ];
    if (credentials.username) pairs.push([`${envPrefix}_USER`, credentials.username]);
    if (credentials.password) pairs.push([`${envPrefix}_PASSWORD`, credentials.password]);
    if (credentials.database) pairs.push([`${envPrefix}_NAME`, credentials.database]);

    for (const [key, value] of pairs) {
      const isSecret = secretKeys.has(key);
      if (isSecret) {
        const { encrypted_value, iv } = await encryptValue(value);
        newEntries.push({ key, value: "", encrypted_value, iv, secret: true, updated_at: now });
      } else {
        newEntries.push({ key, value, secret: false, updated_at: now });
      }
    }

    // Write service env vars to the app's linked environment
    if (app.environment_id) {
      const envRow = db.getEnvironment(app.environment_id, ctx.orgId);
      if (envRow) {
        const envParsed = parseEnvVars(envRow.env_vars);
        const newKeys = new Set(newEntries.map((e) => e.key));
        const filtered = envParsed.entries.filter((e) => !newKeys.has(e.key));
        db.updateEnvironment(app.environment_id, envRow.name, serializeEnvVars([...filtered, ...newEntries]));
      }
    } else {
      // Fallback: create an environment for the app if it doesn't have one
      const envName = app.name;
      const envRow = db.insertEnvironment(envName, serializeEnvVars(newEntries), ctx.orgId);
      db.updateAppEnvironment(appId, envRow.id);
    }

    // Create link record
    try {
      db.insertServiceLink(serviceId, appId, envPrefix);
    } catch {
      // UNIQUE constraint — link already exists, just update env vars
    }

    // No per-host Docker-bridge hack needed: with services bound to
    // their server's private IPv4 on the shared ocd-net Hetzner network,
    // the app reaches the DB directly via its DATABASE_URL / _HOST env
    // vars regardless of whether they're colocated on the same server.

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnlinkService(request: Request, serviceId: number, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "services.link");

    const service = db.getService(serviceId, ctx.orgId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const app = db.getApp(appId, ctx.orgId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }

    // Get the link to find env prefix
    const links = db.getServiceLinks(serviceId);
    const link = links.find((l) => l.app_id === appId);
    if (!link) {
      return Response.json({ error: "Link not found" }, { status: 404, headers: corsHeaders });
    }

    const prefix = link.env_prefix || "DATABASE";

    // Remove injected env vars from the app's linked environment
    if (app.environment_id) {
      const envRow = db.getEnvironment(app.environment_id, ctx.orgId);
      if (envRow) {
        const envParsed = parseEnvVars(envRow.env_vars);
        const filtered = envParsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
        db.updateEnvironment(app.environment_id, envRow.name, serializeEnvVars(filtered));
      }
    }

    db.deleteServiceLink(serviceId, appId);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
