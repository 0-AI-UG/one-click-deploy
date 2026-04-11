import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { scaleApp, wakeApp, collectMetrics } from "../../bun/scale.ts";
import { updateScaleDaemonConfig } from "../../bun/remote/index.ts";
import { secretStore } from "../../bun/secret-store.ts";
import { notifyJob } from "./apps.ts";

export async function handleScaleApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const body = await request.json() as { replicas: number };
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
        });
        db.finishDeployJob(job.id, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.appendDeployJobEvent(job.id, "error", msg);
        db.finishDeployJob(job.id, { ok: false, error: msg });
      } finally {
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

    // Update scale daemon config if app is scaled
    const app = db.getApp(appId);
    if (app && app.lb_provider_id) {
      const replicas = db.getReplicas(appId);
      const primaryServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
      if (primaryServer) {
        const tokens = await secretStore.getTokens();
        await updateScaleDaemonConfig(
          primaryServer.ipv4,
          {
            hetzner_token: tokens.hetzner_api_token,
            apps: [{
              app_name: app.name,
              hetzner_lb_id: app.lb_provider_id,
              container_port: app.container_port,
              min_replicas,
              max_replicas,
              cpu_threshold,
              mem_threshold,
              cooldown_seconds: app.autoscale_cooldown,
              replicas: replicas.map((r) => {
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

/**
 * Caddy on-demand-TLS `ask` endpoint.
 *
 * Caddy on the panel server calls this before issuing a Let's Encrypt cert
 * for a tenant domain. We authorize only if the domain currently has a
 * wake-page route installed on the panel (freeze worker sets the flag,
 * wake path clears it). Any other response is treated by Caddy as "don't
 * mint a cert for this domain" — which hard-stops attempts to abuse the
 * panel as an open ACME relay for arbitrary DNS names pointed at us.
 *
 * Must be unauthenticated — Caddy has no credentials at this stage.
 */
export async function handleCaddyAsk(request: Request): Promise<Response> {
  const domain = new URL(request.url).searchParams.get("domain") || "";
  if (!domain) {
    return new Response("missing domain", { status: 400 });
  }
  // Reject internal / nip.io domains outright — they never use on-demand
  // ACME, they go through Caddy's internal issuer on the tenant server.
  if (domain.endsWith(".nip.io") || domain.endsWith(".localhost")) {
    return new Response("internal domain", { status: 404 });
  }
  const app = db.getAppByDomain(domain);
  if (!app) {
    return new Response("unknown domain", { status: 404 });
  }
  if (!app.wake_page_on_panel) {
    return new Response("not hosted on panel", { status: 404 });
  }
  return new Response("ok", { status: 200 });
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
