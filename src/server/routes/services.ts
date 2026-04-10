import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { deployService, type ServiceDeployRequest } from "../../bun/deploy/deploy-service.ts";
import {
  destroyService,
  restartService,
  pauseService,
  unpauseService,
  getServiceLogs,
} from "../../bun/deploy/service-lifecycle.ts";
import { scaleService } from "../../bun/scale-service.ts";
import { getCatalogEntries, buildConnectionUrl, getCatalogEntry } from "../../bun/services/catalog.ts";

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
      replicationSupported: e.replication.supported,
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
        instance_count: instances.length,
        primary_instance: instances.find((i) => i.role === "primary") || null,
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
    const instances = db.getServiceInstances(serviceId);
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
    const result = await destroyService(serviceId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.restart");
    const result = await restartService(serviceId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const result = await pauseService(serviceId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const result = await unpauseService(serviceId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Scale ---

export async function handleScaleService(request: Request, serviceId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const body = await request.json();
    const { instances } = body;
    if (typeof instances !== "number" || instances < 1) {
      return Response.json({ ok: false, error: "instances must be >= 1" }, { status: 400, headers: corsHeaders });
    }
    const result = await scaleService(serviceId, instances);
    return Response.json(result, { headers: corsHeaders });
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
    const serviceEnv = JSON.parse(service.env_vars || "{}");

    // Inject connection env vars into the app
    const appEnv = JSON.parse(app.env_vars || "{}");
    appEnv[`${envPrefix}_URL`] = credentials.connection_url || "";
    appEnv[`${envPrefix}_HOST`] = credentials.host || "";
    appEnv[`${envPrefix}_PORT`] = String(credentials.port || "");
    if (credentials.username) appEnv[`${envPrefix}_USER`] = credentials.username;
    if (credentials.password) appEnv[`${envPrefix}_PASSWORD`] = credentials.password;
    if (credentials.database) appEnv[`${envPrefix}_NAME`] = credentials.database;

    // Add replica URLs if replicas exist
    const replicas = db.getReplicaInstances(serviceId);
    if (replicas.length > 0) {
      const replicaUrls = replicas.map((r) => {
        const server = db.getServer(r.server_id);
        if (!server) return "";
        return buildConnectionUrl(catalog, serviceEnv, server.ipv4, r.host_port);
      }).filter(Boolean);
      if (replicaUrls.length > 0) {
        appEnv[`${envPrefix}_REPLICA_URLS`] = replicaUrls.join(",");
      }
    }

    db.updateAppEnvVars(appId, JSON.stringify(appEnv));

    // Create link record
    try {
      db.insertServiceLink(serviceId, appId, envPrefix);
    } catch {
      // UNIQUE constraint — link already exists, just update env vars
    }

    // Connect app container to ocd-net if not already connected
    const appReplicas = db.getReplicas(appId);
    for (const replica of appReplicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      try {
        const { sshExec } = await import("../../bun/hetzner/ssh.ts");
        await sshExec(
          server.ipv4,
          `su - deploy -c "docker network connect ocd-net ${replica.container_name} 2>/dev/null || true"`,
          hostKey
        );
      } catch (e) {
        console.error(`services: failed to connect ${replica.container_name} to ocd-net:`, e);
      }
    }

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

    // Remove injected env vars
    const appEnv = JSON.parse(app.env_vars || "{}");
    const keysToRemove = Object.keys(appEnv).filter((k) => k.startsWith(`${prefix}_`));
    for (const key of keysToRemove) {
      delete appEnv[key];
    }
    db.updateAppEnvVars(appId, JSON.stringify(appEnv));

    db.deleteServiceLink(serviceId, appId);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
