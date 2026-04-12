import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { parseEnvVars, serializeEnvVars, encryptValue } from "../../bun/env-crypto.ts";
import type { EnvVarEntry } from "../../bun/env-crypto.ts";
import { deployService, type ServiceDeployRequest } from "../../bun/deploy/deploy-service.ts";
import {
  destroyService,
  restartService,
  pauseService,
  unpauseService,
  getServiceLogs,
} from "../../bun/deploy/service-lifecycle.ts";
import { getCatalogEntries, getCatalogEntry } from "../../bun/services/catalog.ts";
import { tryAcquireLock } from "../../bun/op-lock.ts";

// Long-poll notifier (same pattern as app deploy jobs)
const jobWaiters = new Map<number, Set<() => void>>();

function notifyJob(jobId: number) {
  const set = jobWaiters.get(jobId);
  if (!set) return;
  for (const w of set) w();
}

function waitForJob(jobId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      jobWaiters.get(jobId)?.delete(wake);
      if (jobWaiters.get(jobId)?.size === 0) jobWaiters.delete(jobId);
      clearTimeout(timer);
      resolve();
    };
    const wake = () => finish();
    if (!jobWaiters.has(jobId)) jobWaiters.set(jobId, new Set());
    jobWaiters.get(jobId)!.add(wake);
    const timer = setTimeout(finish, timeoutMs);
  });
}

const LONG_POLL_TIMEOUT_MS = 25_000;

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
    await requirePermission(request, "servers.view");
    const services = db.getServices();
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
      linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name, env_prefix: l.env_prefix })),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Deploy ---

export async function handleDeployService(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const req: ServiceDeployRequest = await request.json();

    const job = db.createServiceDeployJob(req.name);

    (async () => {
      try {
        const result = await deployService(req, (step, detail) => {
          db.appendServiceDeployJobEvent(job.id, step, detail);
          notifyJob(job.id);
        });
        db.finishServiceDeployJob(job.id, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.appendServiceDeployJobEvent(job.id, "error", msg);
        db.finishServiceDeployJob(job.id, { ok: false, error: msg });
      } finally {
        notifyJob(job.id);
      }
    })();

    return Response.json({ deployment_id: job.id }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleServiceDeployJobPoll(request: Request, jobId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;

    const job = db.getServiceDeployJob(jobId);
    if (!job) {
      return Response.json({ error: "Deploy job not found" }, { status: 404, headers: corsHeaders });
    }

    let events = db.getServiceDeployJobEvents(jobId, since);

    if (events.length === 0 && job.status === "running") {
      await Promise.race([
        waitForJob(jobId, LONG_POLL_TIMEOUT_MS),
        new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve())),
      ]);
      events = db.getServiceDeployJobEvents(jobId, since);
    }

    const fresh = db.getServiceDeployJob(jobId)!;
    const result = fresh.result_json ? JSON.parse(fresh.result_json) : null;
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : since;

    return Response.json({
      status: fresh.status,
      service_name: fresh.service_name,
      events,
      last_seq: lastSeq,
      result,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.destroy");
    const lock = tryAcquireLock(`service:${serviceId}`, "destroy");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `Service is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await destroyService(serviceId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.restart");
    const lock = tryAcquireLock(`service:${serviceId}`, "restart");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `Service is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await restartService(serviceId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const lock = tryAcquireLock(`service:${serviceId}`, "pause");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `Service is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await pauseService(serviceId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const lock = tryAcquireLock(`service:${serviceId}`, "unpause");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `Service is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await unpauseService(serviceId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

// --- Logs ---

export async function handleGetServiceLogs(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
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
    await requirePermission(request, "apps.env");
    const body = await request.json().catch(() => ({}));
    const envPrefix = body.env_prefix || "DATABASE";

    const service = db.getService(serviceId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const app = db.getApp(appId);
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
      const envRow = db.getEnvironment(app.environment_id);
      if (envRow) {
        const envParsed = parseEnvVars(envRow.env_vars);
        const newKeys = new Set(newEntries.map((e) => e.key));
        const filtered = envParsed.entries.filter((e) => !newKeys.has(e.key));
        db.updateEnvironment(app.environment_id, envRow.name, serializeEnvVars([...filtered, ...newEntries]));
      }
    } else {
      // Fallback: create an environment for the app if it doesn't have one
      const envName = app.name;
      const envRow = db.insertEnvironment(envName, serializeEnvVars(newEntries));
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
    await requirePermission(request, "apps.env");

    const service = db.getService(serviceId);
    if (!service) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    const app = db.getApp(appId);
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
      const envRow = db.getEnvironment(app.environment_id);
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
