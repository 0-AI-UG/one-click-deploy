import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
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
      icon: e.icon,
      color: e.color,
      http: e.http,
      // Compose services back their volume via subpaths, so a missing
      // volumePath alone doesn't make them stateless.
      stateless: !e.volumePath && !(e.volumeSubpaths && e.volumeSubpaths.length),
      description: e.description,
      category: e.category,
      recommendedMemoryMb: e.recommendedMemoryMb,
    }));
    return Response.json(entries, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetServices(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const services = db.getServices();
    const result = services.map((s) => {
      const instances = db.getServiceInstances(s.id);
      const links = db.getServiceLinks(s.id);
      return {
        ...s,
        primary_instance: instances[0] || null,
        linked_environments: links.map((l) => ({ id: l.environment_id, name: l.environment_name, env_prefix: l.env_prefix })),
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
    await requirePermission(request, "servers.view");
    const service = db.getService(serviceId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    // Join the hosting server's name onto each instance so the detail page
    // can show a meaningful "Server" column without a second fetch.
    const instances = db.getServiceInstances(serviceId).map((inst) => {
      const srv = db.getServer(inst.server_id);
      return { ...inst, server_name: srv?.name ?? `srv#${inst.server_id}` };
    });
    const links = db.getServiceLinks(serviceId);
    return Response.json({
      ...service,
      credentials: JSON.parse(service.credentials || "{}"),
      instances,
      linked_environments: links.map((l) => ({ id: l.environment_id, name: l.environment_name, env_prefix: l.env_prefix })),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Deploy ---

export async function handleDeployService(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "services.deploy");
    const req: ServiceDeployRequest = await request.json();
    if (!req?.name || typeof req.name !== "string") {
      return Response.json({ ok: false, error: "name is required" }, { status: 400, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy_service",
      resourceKeys: [`service:create:${req.name}`],
      input: req,
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyService(request: Request, serviceId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "services.destroy");
    const { opId } = enqueue({
      kind: "destroy_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartService(request: Request, serviceId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "services.manage");
    const { opId } = enqueue({
      kind: "restart_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "services.manage");
    const { opId } = enqueue({
      kind: "pause_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "services.manage");
    const { opId } = enqueue({
      kind: "unpause_service",
      resourceKeys: [`service:${serviceId}`],
      input: { serviceId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Logs ---

export async function handleGetServiceLogs(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "services.logs");
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

// --- Inject service credentials into an environment ---

export async function handleInjectService(request: Request, serviceId: number, environmentId: number): Promise<Response> {
  try {
    await requirePermission(request, "services.link");
    const body = await request.json().catch(() => ({}));
    const envPrefix = body.env_prefix || "DATABASE";

    const service = db.getService(serviceId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const envRow = db.getEnvironment(environmentId);
    if (!envRow) {
      return Response.json({ error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    if (!getCatalogEntry(service.service_type)) {
      return Response.json({ error: "Unknown service type" }, { status: 400, headers: corsHeaders });
    }

    const credentials = JSON.parse(service.credentials || "{}");
    const now = new Date().toISOString();
    const newEntries: EnvVarEntry[] = [];
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
      if (secretKeys.has(key)) {
        const { encrypted_value, iv } = await encryptValue(value);
        newEntries.push({ key, value: "", encrypted_value, iv, secret: true, updated_at: now });
      } else {
        newEntries.push({ key, value, secret: false, updated_at: now });
      }
    }

    const envParsed = parseEnvVars(envRow.env_vars);
    const newKeys = new Set(newEntries.map((e) => e.key));
    const filtered = envParsed.entries.filter((e) => !newKeys.has(e.key));
    db.updateEnvironment(environmentId, envRow.name, serializeEnvVars([...filtered, ...newEntries]));

    db.insertServiceLink(serviceId, environmentId, envPrefix);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUninjectService(request: Request, serviceId: number, environmentId: number): Promise<Response> {
  try {
    await requirePermission(request, "services.link");

    const service = db.getService(serviceId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const envRow = db.getEnvironment(environmentId);
    if (!envRow) {
      return Response.json({ error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }

    const links = db.getServiceLinks(serviceId);
    const link = links.find((l) => l.environment_id === environmentId);
    if (!link) {
      return Response.json({ error: "Link not found" }, { status: 404, headers: corsHeaders });
    }

    const prefix = link.env_prefix || "DATABASE";
    const envParsed = parseEnvVars(envRow.env_vars);
    const filtered = envParsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
    db.updateEnvironment(environmentId, envRow.name, serializeEnvVars(filtered));

    db.deleteServiceLink(serviceId, environmentId);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
