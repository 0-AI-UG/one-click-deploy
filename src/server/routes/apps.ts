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
import { introspectRepo } from "../../bun/github-introspect.ts";

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

export async function handleIntrospectRepo(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const url = new URL(request.url).searchParams.get("url") || "";
    if (!url) {
      return Response.json(
        { ok: false, error: "Missing repo URL" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await introspectRepo(url);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
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
    const apps = db.getApps();
    const result = apps.map((a: any) => {
      const reps = db.getReplicas(a.id);
      const first = reps[0];
      const servers = db.getServersForApp(a.id).map((s: any) => s.id);
      return { ...a, host_port: first?.host_port ?? 0, servers };
    });
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
    const body = (await request.json().catch(() => ({}))) as { env_vars?: Record<string, string>; auth_password?: string | null };
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
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) return Response.json({ logs: "", error: "App has no replicas" }, { headers: corsHeaders });
    const server = db.getServer(replicas[0].server_id);
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
