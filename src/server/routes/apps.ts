import { corsHeaders } from "../lib/cors.ts";
import { requireOrgPermission, requireOrgContext } from "../lib/org-context.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { getComposeLogs, getContainerLogs } from "../../shared/remote/index.ts";
import { validateAppName } from "../../shared/validate.ts";
import { introspectRepo } from "../../shared/github-introspect.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { canCreateApp, canRedeployApp } from "./billing.ts";

/** Enrich app row for API responses — adds environment name, drops raw env_vars. */
function enrichAppForResponse(app: AppRow & Record<string, unknown>) {
  const envRow = app.environment_id ? db.getEnvironment(app.environment_id as number) : null;
  return {
    ...app,
    env_vars: [],
    environment_id: app.environment_id ?? null,
    environment_name: envRow?.name ?? null,
  };
}

export async function handleIntrospectRepo(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    const params = new URL(request.url).searchParams;
    const url = params.get("url") || "";
    const ref = params.get("ref") || undefined;
    if (!url) {
      return Response.json(
        { ok: false, error: "Missing repo URL" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await introspectRepo(url, ctx.userId, ref);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "servers.view");
    const result = getServersWithApps(ctx.orgId).map((s) => ({
      ...s,
      apps: (s.apps || []).map((a) => enrichAppForResponse(a)),
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDashboard(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "servers.view");
    const apps = db.getApps(ctx.orgId).map((a) => {
      const reps = db.getReplicas(a.id);
      return enrichAppForResponse({ ...a, desired_replicas: a.desired_replicas ?? reps.length });
    });
    const services = db.getServices(ctx.orgId).map((svc) => {
      const instances = db.getServiceInstances(svc.id);
      const links = db.getServiceLinks(svc.id);
      return {
        ...svc,
        instance_count: instances.length,
        linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name })),
      };
    });
    return Response.json({ apps, services }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetApps(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "servers.view");
    const apps = db.getApps(ctx.orgId);
    const result = apps.map((a) => {
      const reps = db.getReplicas(a.id);
      const first = reps[0];
      const servers = db.getServersForApp(a.id).map((s) => s.id);
      return enrichAppForResponse({ ...a, host_port: first?.host_port ?? 0, servers });
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeploy(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    if (!canCreateApp(ctx.orgId)) {
      return Response.json({ ok: false, error: "Billing required", code: "BILLING_REQUIRED" }, { status: 402, headers: corsHeaders });
    }
    const req = await request.json();
    if (!req?.app_name || typeof req.app_name !== "string") {
      return Response.json({ ok: false, error: "app_name is required" }, { status: 400, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy",
      resourceKeys: [`app:create:${req.app_name}`],
      input: req,
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.destroy");
    const { opId } = enqueue({
      kind: "destroy_app",
      resourceKeys: [`app:${appId}`],
      input: { appId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.restart");
    const { opId } = enqueue({
      kind: "restart_app",
      resourceKeys: [`app:${appId}`],
      input: { appId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.pause");
    const { opId } = enqueue({
      kind: "pause_app",
      resourceKeys: [`app:${appId}`],
      input: { appId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.pause");
    const { opId } = enqueue({
      kind: "unpause_app",
      resourceKeys: [`app:${appId}`],
      input: { appId },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.redeploy");
    if (!canRedeployApp(ctx.orgId)) {
      return Response.json({ ok: false, error: "Billing required", code: "BILLING_REQUIRED" }, { status: 402, headers: corsHeaders });
    }
    const body = (await request.json().catch(() => ({}))) as {
      auth_password?: string | null;
      container_port?: number;
      environment_id?: number | null;
      public?: boolean;
    };

    if (body.container_port !== undefined) {
      const p = Number(body.container_port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return Response.json({ ok: false, error: "Port must be an integer between 1 and 65535" }, { headers: corsHeaders });
      }
      body.container_port = p;
    }

    if (body.environment_id !== undefined) {
      db.updateAppEnvironment(appId, body.environment_id);
    }

    if (body.public !== undefined) {
      db.updateAppPublic(appId, body.public);
    }

    const { opId } = enqueue({
      kind: "redeploy",
      resourceKeys: [`app:${appId}`],
      input: {
        appId,
        auth_password: body.auth_password,
        container_port: body.container_port,
        userId: ctx.userId,
      },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRenameApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    const { name } = await request.json() as { name: string };

    const nameResult = validateAppName(name);
    if (!nameResult.valid) {
      return Response.json({ error: nameResult.error }, { status: 400, headers: corsHeaders });
    }
    const newName = nameResult.value;

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    if (newName === app.name) {
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    const existing = db.getAppByName(newName, ctx.orgId);
    if (existing) {
      return Response.json({ error: `An app named "${newName}" already exists` }, { status: 409, headers: corsHeaders });
    }

    const { opId } = enqueue({
      kind: "rename_app",
      resourceKeys: [`app:${appId}`],
      input: { appId, newName },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetContainerLogs(request: Request, appId: number): Promise<Response> {
  try {
    await requireOrgPermission(request, "apps.logs");
    const url = new URL(request.url);
    const tail = parseInt(url.searchParams.get("tail") || "100", 10);
    const replicaIdParam = url.searchParams.get("replica_id");

    const app = db.getApp(appId);
    if (!app) return Response.json({ logs: "", error: "App not found" }, { headers: corsHeaders });
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) return Response.json({ logs: "", error: "App has no replicas" }, { headers: corsHeaders });

    let replica = replicas[0];
    if (replicaIdParam) {
      const requested = replicas.find((r) => r.id === parseInt(replicaIdParam, 10));
      if (!requested) return Response.json({ logs: "", error: "Replica not found" }, { headers: corsHeaders });
      replica = requested;
    }

    const server = db.getServer(replica.server_id);
    if (!server) return Response.json({ logs: "", error: "Server not found" }, { headers: corsHeaders });

    const logs = app.deploy_mode === "compose"
      ? await getComposeLogs(server.ipv4, app.name, tail, server.ssh_host_key || undefined)
      : await getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined);

    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployLog(request: Request, appId: number): Promise<Response> {
  try {
    await requireOrgPermission(request, "apps.logs");
    const log = db.getDeployLog(appId);
    return Response.json({ log }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployments(request: Request, appId: number): Promise<Response> {
  try {
    await requireOrgPermission(request, "apps.logs");
    const deployments = db.getDeployments(appId);
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.rollback");
    const body = await request.json() as { deployment_id: number };
    const { opId } = enqueue({
      kind: "rollback",
      resourceKeys: [`app:${appId}`],
      input: { appId, deploymentId: body.deployment_id },
      trigger: "ui",
      triggeredBy: ctx.userId,
      orgId: ctx.orgId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
