import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { scaleApp, collectMetrics } from "../../bun/scale.ts";
import * as hetzner from "../../bun/hetzner/index.ts";
import { secretStore } from "../../bun/secret-store.ts";

export async function handleScaleApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const { replicas } = await request.json() as { replicas: number };
    const result = await scaleApp(appId, replicas, () => {});
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateScalingPolicy(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "scaling.manage");
    const { min_replicas, max_replicas, autoscale_enabled, cpu_threshold, mem_threshold } = await request.json() as {
      min_replicas: number;
      max_replicas: number;
      autoscale_enabled: boolean;
      cpu_threshold: number;
      mem_threshold: number;
    };

    db.updateAppScaling(appId, {
      min_replicas,
      max_replicas,
      autoscale_enabled,
      autoscale_cpu_threshold: cpu_threshold,
      autoscale_mem_threshold: mem_threshold,
    });

    // Update scale daemon config if app is scaled
    const app = db.getApp(appId);
    if (app && app.hetzner_lb_id) {
      const primaryServer = db.getServer(app.server_id);
      if (primaryServer) {
        const replicas = db.getReplicas(appId);
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
