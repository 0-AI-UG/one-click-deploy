import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { scaleApp, wakeApp, collectMetrics } from "../../bun/scale.ts";
import * as hetzner from "../../bun/hetzner/index.ts";
import { secretStore } from "../../bun/secret-store.ts";

export async function handleScaleApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const body = await request.json() as { replicas: number };
    const replicas = Number(body.replicas);
    if (!Number.isFinite(replicas) || replicas < 0) {
      return Response.json({ error: "replicas must be an integer >= 0" }, { status: 400, headers: corsHeaders });
    }
    const app = db.getApp(appId);
    if (app && replicas > 1 && (!app.domain || app.domain.endsWith(".nip.io"))) {
      return Response.json({ error: "Scaling requires a custom domain. Add a domain in app settings first." }, { status: 400, headers: corsHeaders });
    }
    const result = await scaleApp(appId, replicas, () => {});
    if (!result.ok) {
      return Response.json({ error: result.error || "Scaling failed" }, { status: 400, headers: corsHeaders });
    }
    return Response.json(result, { headers: corsHeaders });
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

    // Update scale daemon config if app is scaled
    const app = db.getApp(appId);
    if (app && app.hetzner_lb_id) {
      const replicas = db.getReplicas(appId);
      const primaryServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
      if (primaryServer) {
        const tokens = await secretStore.getTokens();
        await hetzner.updateScaleDaemonConfig(
          primaryServer.ipv4,
          {
            hetzner_token: tokens.hetzner_api_token,
            apps: [{
              app_name: app.name,
              hetzner_lb_id: app.hetzner_lb_id,
              container_port: app.container_port,
              min_replicas,
              max_replicas,
              cpu_threshold,
              mem_threshold,
              cooldown_seconds: app.autoscale_cooldown,
              replicas: replicas.map((r: any) => {
                const s = db.getServer(r.server_id);
                return {
                  server_ip: s?.ipv4 || "",
                  container_name: r.container_name,
                  host_port: r.host_port,
                };
              }),
            }],
          },
          primaryServer.ssh_host_key || undefined,
        );
      }
    }

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
    // Fire-and-forget: wake in the background so the response returns immediately
    wakeApp(appId).catch(err => console.error(`[wake] Failed to wake app ${appId}:`, err));
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
  if (!token || token !== app.wake_token) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: wakeCorsHeaders });
  }
  return Response.json({ status: app.status }, { headers: wakeCorsHeaders });
}
