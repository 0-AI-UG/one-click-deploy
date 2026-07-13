import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";

export async function handleScaleApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "scaling.manage");
    const body = await request.json() as { replicas: number; server_id?: number };
    const replicas = Number(body.replicas);
    if (!Number.isFinite(replicas) || replicas < 0) {
      return Response.json({ error: "replicas must be an integer >= 0" }, { status: 400, headers: corsHeaders });
    }
    const app = db.getApp(appId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    // No domain requirement: the panel is the sole public ingress and fans out
    // to all replicas over the private network, so a nip.io auto-domain
    // (<app>.<panel-ip>.nip.io → the panel) load-balances just as well as a
    // custom domain. The nip.io↔custom-domain difference is only TLS and IP
    // stability, both orthogonal to replica count.
    if (replicas > 1 && app.volume_id) {
      return Response.json({ error: "Apps with persistent storage cannot have more than 1 replica." }, { status: 400, headers: corsHeaders });
    }

    // Sleeping/waking apps keep one replica row as a "stopped anchor" so
    // count comparisons against `replicas` are misleading — scaling to 1
    // looks like a no-op even though the app is asleep. Route any scale-up
    // request through the wake op instead. The idempotency key coalesces
    // repeated wake clicks for the same sleeping app into one op.
    if ((app.status === "sleeping" || app.status === "waking") && replicas >= 1) {
      const { opId } = enqueue({
        kind: "wake",
        resourceKeys: [`app:${appId}`],
        input: { appId },
        trigger: "ui",
        triggeredBy: payload.userId,
        idempotencyKey: `wake:${appId}`,
      });
      return Response.json({ op_id: opId }, { headers: corsHeaders });
    }

    const current = db.getReplicas(appId).length;
    if (replicas === current) {
      return Response.json({ ok: true, op_id: null, noop: true }, { headers: corsHeaders });
    }

    // Level-triggered: write the desired count and let the reconciler's
    // convergence loop add/remove replicas (or sleep the app when replicas=0).
    // No op is enqueued — there is nothing to poll; the panel reflects the new
    // replica set within one reconciler tick.
    db.updateAppScaling(appId, {
      desired_replicas: replicas,
      last_scale_at: new Date().toISOString(),
    });
    db.insertScalingEvent({
      app_id: appId,
      event_type: replicas > current ? "scale_up" : "scale_down",
      from_count: current,
      to_count: replicas,
      reason: "manual",
    });
    return Response.json({ ok: true, op_id: null, desired: replicas }, { headers: corsHeaders });
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
      // Volume apps cannot scale beyond 1 replica — a cloud volume can only be
      // attached to a single server. (No custom-domain requirement: nip.io
      // auto-domains route through the panel and load-balance across replicas.)
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
    // Serve the reconciler's already-persisted per-replica metrics
    // (cpu_percent / memory_percent, refreshed every ≤30s tick) rather than a
    // per-request SSH `docker stats` fan-out across every replica.
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

export async function handleMigrateReplica(request: Request, appId: number, replicaId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "scaling.manage");
    const body = await request.json() as { target_server_id: number };
    if (!body.target_server_id) {
      return Response.json({ error: "target_server_id is required" }, { status: 400, headers: corsHeaders });
    }

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const { opId } = enqueue({
      kind: "migrate",
      resourceKeys: [`app:${appId}`],
      input: { appId, replicaId, targetServerId: body.target_server_id },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
