import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireAuthenticated, appScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { getContainerLogs } from "../../shared/remote/index.ts";
import { validateAppName } from "../../shared/validate.ts";
import { syncAppIngress, getPanelIngressIpv4 } from "../../engine/scale/traefik-manager.ts";
import { introspectRepo } from "../../shared/github-introspect.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enqueueOp } from "./_ops.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../../engine/scheduler.ts";
import { applyAppConfig, diffAppConfig, mergeDeployRequestWithExistingApp } from "../../shared/app-config.ts";
import type { DeployRequest } from "../../shared/rpc.ts";

/** Enrich app row for API responses — adds environment name, the resolved
 *  public raw TCP/UDP address, a boolean `auth_enabled` flag, and strips every
 *  secret/credential field so nothing sensitive leaks to `apps.view` users.
 *  `auth_password_hash` is the source of truth for "auth on" but is itself a
 *  credential (bcrypt hash), so only the derived boolean goes out. */
export function enrichAppForResponse(app: AppRow & Record<string, unknown>) {
  const envRow = app.environment_id ? db.getEnvironment(app.environment_id as number) : null;
  const panelIp = app.public_port != null ? getPanelIngressIpv4() : null;
  const { auth_password_hash, webhook_secret, ...safe } = app;
  return {
    ...safe,
    env_vars: [],
    auth_enabled: !!auth_password_hash,
    environment_id: app.environment_id ?? null,
    environment_name: envRow?.name ?? null,
    deployed_commit: db.getDeployedCommit(app.id),
    public_address: app.public_port != null && panelIp ? `${panelIp}:${app.public_port}` : null,
  };
}

// One introspect endpoint for both deploy modes: `introspectRepo` detects an
// `ocd-stack.json` and returns a `kind: "stack"` result, else `kind: "app"`.
// The optional `path` param overrides which stack manifest to resolve.
export async function handleIntrospectRepo(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const params = new URL(request.url).searchParams;
    const url = params.get("url") || "";
    const ref = params.get("ref") || undefined;
    const path = params.get("path") || undefined;
    if (!url) {
      return Response.json(
        { ok: false, error: "Missing repo URL" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await introspectRepo(url, payload.userId, ref, path);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = getServersWithApps().map((s: any) => ({
      ...s,
      apps: (s.apps || []).map((a: any) => enrichAppForResponse(a)),
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDashboard(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    // Staging siblings (target_of set) are auto-managed via the parent's webhook
    // staging toggle — hide them from the main list so they read as an internal
    // detail of the parent, not a separate app. They stay reachable via the
    // parent's staging panel and /api/apps (which parent lookups still need).
    const apps = db.getApps().filter((a) => a.target_of == null).map((a) => {
      const reps = db.getReplicas(a.id);
      return enrichAppForResponse({ ...a, desired_replicas: a.desired_replicas ?? reps.length });
    });
    const services = db.getServices().map((svc) => {
      const instances = db.getServiceInstances(svc.id);
      const links = db.getServiceLinks(svc.id);
      return {
        ...svc,
        instance_count: instances.length,
        linked_environments: links.map((l) => ({ id: l.environment_id, name: l.environment_name })),
      };
    });
    return Response.json({ apps, services }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetApps(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.view");
    const apps = db.getApps();
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

type AppConfigPatch = Partial<DeployRequest> & {
  dry_run?: boolean;
  deploy?: boolean;
};

/**
 * The single existing-app configuration path. Both a complete manifest apply
 * and a partial UI patch merge into stored desired state here, synchronize
 * ingress, and optionally enqueue the same code-only redeploy operation.
 */
async function applyExistingAppConfig(
  app: AppRow,
  patch: AppConfigPatch,
  userId: number,
  trigger: "api" | "cli" | "ui",
): Promise<Response> {
  const merged = mergeDeployRequestWithExistingApp(app, patch);
  const changes = diffAppConfig(app, merged);
  if (patch.dry_run) {
    return Response.json({
      ok: true,
      dry_run: true,
      changes,
      current_config_revision: app.config_revision,
    }, { headers: corsHeaders });
  }

  const resourceKeys = [`app:${app.id}`];
  const acq = tryAcquire(resourceKeys, NON_OP_HOLDER, "apply_config");
  if (!acq.ok) {
    return Response.json(
      { ok: false, error: `App is busy with another operation (${acq.heldBy.kind}). Try again in a moment.` },
      { status: 409, headers: corsHeaders },
    );
  }

  try {
    await applyAppConfig(app.id, merged, {
      userId,
      log: (line) => db.appendDeployLog(app.id, `[config] ${line}`),
    });
    await syncAppIngress(app.id);

    const result = {
      ok: true,
      applied: true,
      changes,
      config_revision: db.getApp(app.id)?.config_revision,
      op_id: null as number | null,
    };
    if (patch.deploy === false) {
      return Response.json(result, { headers: corsHeaders });
    }

    const { opId } = enqueue({
      kind: "redeploy",
      resourceKeys,
      input: { appId: app.id, userId },
      trigger,
      triggeredBy: userId,
    });
    return Response.json({ ...result, op_id: opId }, { headers: corsHeaders });
  } finally {
    release(resourceKeys);
  }
}

export async function handleDeploy(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const req = await request.json() as AppConfigPatch;
    if (!req?.app_name || typeof req.app_name !== "string") {
      return Response.json({ ok: false, error: "app_name is required" }, { status: 400, headers: corsHeaders });
    }

    // `deploy` is an idempotent complete-manifest apply + rollout. Creation
    // still uses the provisioning saga; existing apps share the same config
    // apply and code-only redeploy implementation as UI patches.
    const existing = db.getAppByName(req.app_name);
    if (existing) {
      return applyExistingAppConfig(
        existing,
        req,
        payload.userId,
        payload.client === "cli" ? "cli" : "api",
      );
    }
    if (req.dry_run) {
      return Response.json(
        { ok: true, dry_run: true, would_create: true, changes: [] },
        { headers: corsHeaders },
      );
    }
    if (req.deploy === false) {
      return Response.json(
        { ok: false, error: `Cannot apply configuration only: app "${req.app_name}" does not exist` },
        { status: 404, headers: corsHeaders },
      );
    }
    const deployRequest = { ...req };
    delete deployRequest.dry_run;
    delete deployRequest.deploy;
    const { opId } = enqueue({
      kind: "deploy",
      resourceKeys: [`app:create:${req.app_name}`],
      input: deployRequest as DeployRequest,
      trigger: payload.client === "cli" ? "cli" : "api",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** Apply a partial UI patch to stored desired configuration and optionally
 * roll it out. Complete manifest reconciliation belongs to handleDeploy. */
export async function handleApplyAppConfig(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy", appScope(appId));
    const body = await request.json() as AppConfigPatch;
    const app = db.getApp(appId);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
    return applyExistingAppConfig(app, body, payload.userId, "ui");
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.destroy", appScope(appId));
    await enforceConfirmation(request, payload, "delete_app", "app", String(appId));
    const { opId } = enqueue({ kind: "destroy_app", resourceKeys: [`app:${appId}`], input: { appId }, trigger: "ui", triggeredBy: payload.userId });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export function handleRestartApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.restart", scope: appScope(appId), kind: "restart_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handlePauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", scope: appScope(appId), kind: "pause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", scope: appScope(appId), kind: "unpause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, {
    permission: "apps.redeploy",
    scope: appScope(appId),
    kind: "redeploy",
    resourceKeys: [`app:${appId}`],
    input: { appId },
  });
}

export async function handleRenameApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.rename", appScope(appId));
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

    const existing = db.getAppByName(newName);
    if (existing) {
      return Response.json({ error: `An app named "${newName}" already exists` }, { status: 409, headers: corsHeaders });
    }

    const { opId } = enqueue({
      kind: "rename_app",
      resourceKeys: [`app:${appId}`],
      input: { appId, newName },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetContainerLogs(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs", appScope(appId));
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

    const logs = await getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined);

    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployLog(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "deployments.view", appScope(appId));
    const log = db.getDeployLog(appId);
    return Response.json({ log }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployments(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "deployments.view", appScope(appId));
    const deployments = db.getDeployments(appId);
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/apps/promote — promote the exact version running in a SOURCE app
 * (e.g. `<name>-staging`) up to a DEST app (production). Validates both apps
 * exist, that they differ, and that the source has a successful deployment to
 * promote; then enqueues the promote op (which rebuilds `<dest>:latest` from the
 * source's git commit and swaps the DEST container(s)).
 */
export async function handlePromoteApp(request: Request): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const body = (await request.json().catch(() => ({}))) as { source_app?: string; dest_app?: string };
    if (!body.source_app || !body.dest_app) {
      return Response.json({ error: "source_app and dest_app are required" }, { status: 400, headers: corsHeaders });
    }

    const source = db.getAppByName(body.source_app);
    if (!source) return Response.json({ error: `Source app not found: ${body.source_app}` }, { status: 404, headers: corsHeaders });
    const dest = db.getAppByName(body.dest_app);
    if (!dest) return Response.json({ error: `Destination app not found: ${body.dest_app}` }, { status: 404, headers: corsHeaders });

    // The promote op acts on the destination app (it rebuilds and swaps DEST's
    // containers), so that's the app the permission is scoped against. The body
    // has to be read first to know which app that is.
    await requirePermission(request, "apps.promote", appScope(dest.id));

    if (source.id === dest.id) {
      return Response.json({ error: "Source and destination must be different apps" }, { status: 400, headers: corsHeaders });
    }

    const commit = db.getDeployments(source.id).find((d) => d.status === "deployed")?.git_commit;
    if (!commit) {
      return Response.json({ error: `Source app "${source.name}" has no successful deployment to promote` }, { status: 400, headers: corsHeaders });
    }

    // Different repos is unusual (promotions normally share a repo) but allowed;
    // surface it in the response so the caller can notice.
    const repo_mismatch = source.git_repo !== dest.git_repo;

    const { opId } = enqueue({
      kind: "promote",
      resourceKeys: [`app:${dest.id}`],
      input: { appId: dest.id, sourceAppId: source.id, userId: payload.userId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId, commit, repo_mismatch }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** The git commit of an app's most recent successful deployment, or null. */
function deployedCommit(appId: number): string | null {
  return db.getDeployments(appId).find((d) => d.status === "deployed")?.git_commit ?? null;
}

/**
 * GET /api/apps/:id/staging — staging status for a production app. Backs the
 * Webhooks-tab staging panel: whether the webhook staging toggle is on, the
 * auto-managed `<name>-staging` sibling (if it's been deployed yet), and the
 * commit each side is running so the UI can show "staging is ahead — promote".
 */
export async function handleGetAppStaging(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.view", appScope(appId));
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const siblingRow = db.getStagingSibling(appId);
    const sibling = siblingRow
      ? {
          id: siblingRow.id,
          name: siblingRow.name,
          status: siblingRow.status,
          domain: siblingRow.domain,
          commit: deployedCommit(siblingRow.id),
        }
      : null;

    return Response.json(
      {
        staging_enabled: app.webhook_staging_environment_id != null,
        staging_environment_id: app.webhook_staging_environment_id,
        prod_commit: deployedCommit(app.id),
        sibling,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.rollback", appScope(appId));
    const body = await request.json() as { deployment_id: number };
    const { opId } = enqueue({
      kind: "rollback",
      resourceKeys: [`app:${appId}`],
      input: { appId, deploymentId: body.deployment_id },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
