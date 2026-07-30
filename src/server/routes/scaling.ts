import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, appScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";

export async function handleWakeApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const app = db.getApp(appId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    if (app.status !== "sleeping" && app.status !== "waking") {
      return Response.json(
        { ok: true, op_id: null, noop: true, status: app.status },
        { headers: corsHeaders },
      );
    }
    const { opId } = enqueue({
      kind: "wake",
      resourceKeys: [`app:${appId}`],
      input: { appId },
      trigger: "ui",
      triggeredBy: payload.userId,
      idempotencyKey: `wake:${appId}`,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetReplicas(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    const replicas = db.getReplicas(appId);
    return Response.json(replicas, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetScalingEvents(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    const events = db.getScalingEvents(appId);
    return Response.json(events, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetAppMetrics(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
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
    await requirePermission(request, "metrics.view", appScope(appId));
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
    const payload = await requirePermission(request, "scaling.migrate", appScope(appId));
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
