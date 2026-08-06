import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, envScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars, encryptValue } from "../../shared/env-crypto.ts";
import type { EnvVarEntry } from "../../shared/env-crypto.ts";
import type { ServiceDeployRequest } from "../../engine/ops/deploy-service.ts";
import { getServiceLogs } from "../../engine/deploy/service-lifecycle.ts";
import { getCatalogEntries, getCatalogEntry } from "../../shared/services/catalog.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enqueueOp } from "./_ops.ts";

// --- Catalog ---

export async function handleGetCatalog(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "services.view");
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
      stateless: !e.volumePath,
      description: e.description,
      category: e.category,
    }));
    return Response.json(entries, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetServices(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "services.view");
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
    await requirePermission(request, "services.view");
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
      trigger: payload.client === "cli" ? "cli" : "api",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export function handleDestroyService(request: Request, serviceId: number): Promise<Response> {
  const volumeKeys = db.getServiceInstances(serviceId)
    .filter((instance) => !!instance.volume_id)
    .map((instance) => `volume:${instance.volume_id}`);
  return enqueueOp(request, {
    permission: "services.destroy",
    kind: "destroy_service",
    resourceKeys: [`service:${serviceId}`, ...volumeKeys],
    input: { serviceId },
  });
}

export function handleRestartService(request: Request, serviceId: number): Promise<Response> {
  return enqueueOp(request, { permission: "services.manage", kind: "restart_service", resourceKeys: [`service:${serviceId}`], input: { serviceId } });
}

export function handlePauseService(request: Request, serviceId: number): Promise<Response> {
  return enqueueOp(request, { permission: "services.manage", kind: "pause_service", resourceKeys: [`service:${serviceId}`], input: { serviceId } });
}

export function handleUnpauseService(request: Request, serviceId: number): Promise<Response> {
  return enqueueOp(request, { permission: "services.manage", kind: "unpause_service", resourceKeys: [`service:${serviceId}`], input: { serviceId } });
}

// --- Logs ---

export async function handleGetServiceLogs(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "services.logs");
    const url = new URL(request.url);
    const instanceId = url.searchParams.get("instance_id")
      ? parseInt(url.searchParams.get("instance_id")!, 10)
      : undefined;
    const requestedTail = parseInt(url.searchParams.get("tail") || "100", 10);
    const tail = Number.isInteger(requestedTail)
      ? Math.max(1, Math.min(requestedTail, 10_000))
      : 100;
    const logs = await getServiceLogs(serviceId, instanceId, tail);
    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Inject service credentials into an environment ---

export async function handleInjectService(request: Request, serviceId: number, environmentId: number): Promise<Response> {
  try {
    // Injecting writes the service's credentials into the environment's env vars,
    // so it needs the secret-write permission on that environment too.
    await requirePermission(request, "services.link");
    await requirePermission(request, "environments.secrets", envScope(environmentId));
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
    const staleApps = db.markAppsEnvironmentStaleForKeys(
      environmentId,
      newEntries.map((entry) => entry.key),
    );

    return Response.json({ ok: true, stale_apps: staleApps }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUninjectService(request: Request, serviceId: number, environmentId: number): Promise<Response> {
  try {
    await requirePermission(request, "services.link");
    await requirePermission(request, "environments.secrets", envScope(environmentId));

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
    const removedKeys = envParsed.entries
      .filter((e) => e.key.startsWith(`${prefix}_`))
      .map((e) => e.key);
    const filtered = envParsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
    db.updateEnvironment(environmentId, envRow.name, serializeEnvVars(filtered));
    const staleApps = db.markAppsEnvironmentStaleForKeys(environmentId, removedKeys);

    db.deleteServiceLink(serviceId, environmentId);

    return Response.json({ ok: true, stale_apps: staleApps }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
