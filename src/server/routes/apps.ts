import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import {
  deploy,
  destroyApp,
  getServersWithApps,
  restartApp,
  pauseApp,
  unpauseApp,
  redeployApp,
  updateAppEnv,
  rollbackApp,
} from "../../bun/deploy/index.ts";
import * as hetzner from "../../bun/hetzner/index.ts";

// In-memory SSE connections for deploy progress
const progressListeners = new Map<string, Set<(step: string, detail: string) => void>>();

function addProgressListener(key: string, listener: (step: string, detail: string) => void) {
  if (!progressListeners.has(key)) progressListeners.set(key, new Set());
  progressListeners.get(key)!.add(listener);
}

function removeProgressListener(key: string, listener: (step: string, detail: string) => void) {
  progressListeners.get(key)?.delete(listener);
  if (progressListeners.get(key)?.size === 0) progressListeners.delete(key);
}

export function notifyProgress(key: string, step: string, detail: string) {
  progressListeners.get(key)?.forEach((l) => l(step, detail));
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const result = getServersWithApps();
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetApps(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const result = db.getApps();
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeploy(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const req = await request.json();
    const progressKey = `deploy-${req.app_name}`;

    const result = await deploy(req, (step, detail) => {
      notifyProgress(progressKey, step, detail);
    });

    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeployStream(request: Request, appName: string): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const progressKey = `deploy-${appName}`;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const listener = (step: string, detail: string) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ step, detail })}\n\n`));
        };
        addProgressListener(progressKey, listener);

        // Cleanup on abort
        request.signal.addEventListener("abort", () => {
          removeProgressListener(progressKey, listener);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.destroy");
    const result = await destroyApp(appId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.restart");
    const result = await restartApp(appId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const result = await pauseApp(appId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const result = await unpauseApp(appId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.redeploy");
    const body = await request.json() as { env_vars?: Record<string, string>; auth_password?: string | null };
    const progressKey = `redeploy-${appId}`;

    const result = await redeployApp(appId, (step, detail) => {
      notifyProgress(progressKey, step, detail);
    }, body.env_vars, body.auth_password);

    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateAppEnv(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.env");
    const body = await request.json() as { env_vars: Record<string, string> };
    const result = await updateAppEnv(appId, body.env_vars);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetContainerLogs(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const url = new URL(request.url);
    const tail = parseInt(url.searchParams.get("tail") || "100", 10);

    const app = db.getApp(appId);
    if (!app) return Response.json({ logs: "", error: "App not found" }, { headers: corsHeaders });
    const server = db.getServer(app.server_id);
    if (!server) return Response.json({ logs: "", error: "Server not found" }, { headers: corsHeaders });

    const logs = app.deploy_mode === "compose"
      ? await hetzner.getComposeLogs(server.ipv4, app.name, tail, server.ssh_host_key || undefined)
      : await hetzner.getContainerLogs(server.ipv4, app.name, tail, server.ssh_host_key || undefined);

    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployLog(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const log = db.getDeployLog(appId);
    return Response.json({ log }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployments(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    // Lazily ingest any webhook-triggered deployments that ran on the server
    // since the last time we synced, so they show up in history alongside
    // manual redeploys.
    try {
      const app = db.getApp(appId);
      if (app?.webhook_enabled) {
        const server = db.getServer(app.server_id);
        if (server?.ipv4) {
          const sinceTs = db.getLatestWebhookDeploymentTs(appId);
          const entries = await hetzner.fetchWebhookHistory(
            server.ipv4,
            app.name,
            sinceTs,
            server.ssh_host_key || undefined
          );
          for (const entry of entries) {
            db.insertDeployment({
              app_id: appId,
              image_tag: entry.image_tag,
              git_commit: entry.git_commit,
              deploy_log: entry.log,
              status: entry.status,
              source: "webhook",
              created_at: entry.ts,
            });
          }
        }
      }
    } catch (syncErr) {
      console.error(`[deployments] webhook history sync failed for app ${appId}:`, syncErr);
    }
    const deployments = db.getDeployments(appId);
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.rollback");
    const body = await request.json() as { deployment_id: number };
    const result = await rollbackApp(appId, body.deployment_id);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
