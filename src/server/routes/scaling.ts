import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { scaleApp, wakeApp, collectMetrics } from "../../bun/scale.ts";
import { migrateReplica } from "../../bun/scale/migrate.ts";
import { notifyJob } from "./apps.ts";
import { tryAcquireLock } from "../../bun/op-lock.ts";

export async function handleScaleApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const body = await request.json() as { replicas: number; server_id?: number };
    const replicas = Number(body.replicas);
    if (!Number.isFinite(replicas) || replicas < 0) {
      return Response.json({ error: "replicas must be an integer >= 0" }, { status: 400, headers: corsHeaders });
    }
    const app = db.getApp(appId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    if (replicas > 1 && (!app.domain || app.domain.endsWith(".nip.io"))) {
      return Response.json({ error: "Scaling requires a custom domain. Add a domain in app settings first." }, { status: 400, headers: corsHeaders });
    }
    if (replicas > 1 && app.volume_id) {
      return Response.json({ error: "Apps with persistent storage cannot have more than 1 replica." }, { status: 400, headers: corsHeaders });
    }

    const lock = tryAcquireLock(`app:${appId}`, "scale");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }

    // Run scaling as a background job and stream progress through the
    // existing deploy_jobs table. The frontend long-polls
    // /api/deploy-jobs/:id?since=N to watch each step in real time instead
    // of staring at a spinner for 30-60 seconds.
    const job = db.createDeployJob(app.name);
    (async () => {
      try {
        const result = await scaleApp(appId, replicas, (step, detail) => {
          db.appendDeployJobEvent(job.id, step, detail);
          notifyJob(job.id);
        }, body.server_id);
        db.finishDeployJob(job.id, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.appendDeployJobEvent(job.id, "error", msg);
        db.finishDeployJob(job.id, { ok: false, error: msg });
      } finally {
        lock.release();
        notifyJob(job.id);
      }
    })();

    return Response.json({ deployment_id: job.id }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateScalingPolicy(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const { min_replicas, max_replicas, autoscale_enabled, cpu_threshold, mem_threshold, cooldown, scale_to_zero_after } = await request.json() as {
      min_replicas: number;
      max_replicas: number;
      autoscale_enabled: boolean;
      cpu_threshold: number;
      mem_threshold: number;
      cooldown?: number;
      scale_to_zero_after?: number;
    };

    if (min_replicas < 0 || max_replicas < min_replicas) {
      return Response.json({ error: "Require 0 <= min_replicas <= max_replicas" }, { status: 400, headers: corsHeaders });
    }

    if (max_replicas > 1) {
      const app = db.getApp(appId);
      if (app && (!app.domain || app.domain.endsWith(".nip.io"))) {
        return Response.json({ error: "Scaling requires a custom domain. Add a domain in app settings first." }, { status: 400, headers: corsHeaders });
      }
      // Volume apps cannot scale beyond 1 replica — a cloud volume can only be
      // attached to a single server.
      if (app && app.volume_id) {
        return Response.json({ error: "Apps with persistent storage cannot have more than 1 replica." }, { status: 400, headers: corsHeaders });
      }
    }

    db.updateAppScaling(appId, {
      min_replicas,
      max_replicas,
      autoscale_enabled,
      autoscale_cpu_threshold: cpu_threshold,
      autoscale_mem_threshold: mem_threshold,
      ...(typeof cooldown === "number" ? { autoscale_cooldown: cooldown } : {}),
      ...(typeof scale_to_zero_after === "number" ? { scale_to_zero_after } : {}),
    });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetReplicas(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const replicas = db.getReplicas(appId);
    return Response.json(replicas, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetScalingEvents(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const events = db.getScalingEvents(appId);
    return Response.json(events, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetAppMetrics(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    await collectMetrics(appId);
    const replicas = db.getReplicas(appId);
    return Response.json(replicas, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetAppMetricsHistory(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const url = new URL(request.url);
    const sinceSec = Math.max(60, Math.min(86400, parseInt(url.searchParams.get("since") || "3600", 10)));
    const samples = db.getRecentAppMetrics(appId, sinceSec);
    return Response.json({ samples, since: sinceSec }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

const wakeCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Token-authenticated — called by the wake page served from the app's domain. */
export async function handleWakeApp(request: Request, appId: number): Promise<Response> {
  try {
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "Not found" }, { status: 404, headers: wakeCorsHeaders });
    const token = new URL(request.url).searchParams.get("token");
    if (!token || token !== app.wake_token) {
      return Response.json({ error: "Forbidden" }, { status: 403, headers: wakeCorsHeaders });
    }
    if (app.status === "waking") return Response.json({ ok: true, status: "waking" }, { headers: wakeCorsHeaders });
    if (app.status !== "sleeping") return Response.json({ ok: true, status: app.status }, { headers: wakeCorsHeaders });
    const lock = tryAcquireLock(`app:${appId}`, "wake");
    if ("busy" in lock) {
      return Response.json({ ok: true, status: "waking" }, { headers: wakeCorsHeaders });
    }
    // Fire-and-forget: wake in the background so the response returns immediately
    wakeApp(appId).catch(err => console.error(`[wake] Failed to wake app ${appId}:`, err)).finally(() => lock.release());
    return Response.json({ ok: true, status: "waking" }, { headers: wakeCorsHeaders });
  } catch (error) {
    return Response.json({ error: "Internal error" }, { status: 500, headers: wakeCorsHeaders });
  }
}

/** Token-authenticated — polled by the wake page to check when the app is ready. */
export async function handleWakeStatus(request: Request, appId: number): Promise<Response> {
  const app = db.getApp(appId);
  if (!app) return Response.json({ error: "Not found" }, { status: 404, headers: wakeCorsHeaders });
  const token = new URL(request.url).searchParams.get("token");
  // If wake_token was cleared, the app already woke — return current status
  if (!app.wake_token) {
    return Response.json({ status: app.status }, { headers: wakeCorsHeaders });
  }
  if (!token || token !== app.wake_token) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: wakeCorsHeaders });
  }
  return Response.json({ status: app.status }, { headers: wakeCorsHeaders });
}

export async function handleMigrateReplica(request: Request, appId: number, replicaId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const body = await request.json() as { target_server_id: number };
    if (!body.target_server_id) {
      return Response.json({ error: "target_server_id is required" }, { status: 400, headers: corsHeaders });
    }

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const lock = tryAcquireLock(`app:${appId}`, "migrate");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }

    const job = db.createDeployJob(app.name);
    (async () => {
      try {
        const result = await migrateReplica(appId, replicaId, body.target_server_id, (step, detail) => {
          db.appendDeployJobEvent(job.id, step, detail);
          notifyJob(job.id);
        });
        db.finishDeployJob(job.id, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.appendDeployJobEvent(job.id, "error", msg);
        db.finishDeployJob(job.id, { ok: false, error: msg });
      } finally {
        lock.release();
        notifyJob(job.id);
      }
    })();

    return Response.json({ deployment_id: job.id }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
