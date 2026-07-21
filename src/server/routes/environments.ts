import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireAuthenticated, envScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { parseEnvVars, maskEnvVarsForResponse, serializeEnvVars, mergeEnvVarUpdate, processIncomingEnvVars } from "../../shared/env-crypto.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";

export async function handleGetEnvironments(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "environments.view");
    const envs = db.getEnvironments();
    const result = envs.map((e) => ({
      ...e,
      env_vars: maskEnvVarsForResponse(parseEnvVars(e.env_vars)),
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateEnvironment(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "environments.manage");
    const body = await request.json();
    const { name, env_vars } = body;
    if (!name || typeof name !== "string") {
      return Response.json({ ok: false, error: "Name is required" }, { status: 400, headers: corsHeaders });
    }
    const existing = db.getEnvironments().find((e) => e.name === name.trim());
    if (existing) {
      return Response.json({ ok: false, error: "An environment with that name already exists" }, { status: 409, headers: corsHeaders });
    }
    const processed = await processIncomingEnvVars(env_vars || []);
    const env = db.insertEnvironment(name.trim(), serializeEnvVars(processed.entries));
    return Response.json({
      ...env,
      env_vars: maskEnvVarsForResponse(parseEnvVars(env.env_vars)),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateEnvironment(request: Request, id: number): Promise<Response> {
  try {
    // This route carries two distinct actions: renaming (plain management) and
    // writing env var *values*, i.e. secrets. They are permissioned separately
    // so a user can be trusted with one without the other; the body decides
    // which checks apply.
    const payload = await requireAuthenticated(request);
    const existing = db.getEnvironment(id);
    if (!existing) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json();
    const { name, env_vars } = body;

    const renaming = typeof name === "string" && name.trim() !== "" && name.trim() !== existing.name;
    if (renaming) {
      await requirePermission(request, "environments.manage", envScope(id));
    }
    if (env_vars !== undefined) {
      await requirePermission(request, "environments.secrets", envScope(id));
    }

    // Only rewrite env vars when the body actually carries them — the merge
    // treats an absent list as "no entries", which would wipe every var on a
    // rename-only request.
    let newSerialized = existing.env_vars;
    if (env_vars !== undefined) {
      const existingParsed = parseEnvVars(existing.env_vars);
      const merged = await mergeEnvVarUpdate(existingParsed, env_vars || []);
      newSerialized = serializeEnvVars(merged.entries);
    }
    const envVarsChanged = newSerialized !== existing.env_vars;
    db.updateEnvironment(id, name || existing.name, newSerialized);

    // Cascade redeploy all attached apps if env vars changed — enqueued as a
    // single fan-out op whose children are individual app redeploys.
    const attachedApps = db.getAppsByEnvironmentId(id);
    let opId: number | null = null;
    if (envVarsChanged && attachedApps.length > 0) {
      const r = enqueue({
        kind: "cascade_redeploy",
        resourceKeys: [`env:${id}`],
        input: { environmentId: id },
        trigger: "ui",
        triggeredBy: payload.userId,
      });
      opId = r.opId;
    }

    return Response.json({
      ok: true,
      redeploying: envVarsChanged ? attachedApps.length : 0,
      op_id: opId,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCopyEnvironment(request: Request, id: number): Promise<Response> {
  try {
    // Creating the copy is a fleet-wide management action; the copy also
    // duplicates the source environment's secrets, so the caller must be
    // allowed to read them out of the source.
    await requirePermission(request, "environments.manage");
    await requirePermission(request, "environments.secrets", envScope(id));
    const src = db.getEnvironment(id);
    if (!src) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json().catch(() => ({}));
    const name = (typeof body.name === "string" && body.name.trim() ? body.name : `${src.name}-copy`).trim();
    if (db.getEnvironments().some((e) => e.name === name)) {
      return Response.json({ ok: false, error: "An environment with that name already exists" }, { status: 409, headers: corsHeaders });
    }
    const env = db.duplicateEnvironment(id, name);
    return Response.json({
      ...env,
      env_vars: maskEnvVarsForResponse(parseEnvVars(env.env_vars)),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteEnvironment(request: Request, id: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "environments.manage", envScope(id));
    await enforceConfirmation(request, payload, "delete_environment", "environment", String(id));
    const env = db.getEnvironment(id);
    if (!env) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const attachedApps = db.getAppsByEnvironmentId(id);
    if (attachedApps.length > 0) {
      const names = attachedApps.map((a) => a.name).join(", ");
      return Response.json({
        ok: false,
        error: `Cannot delete: environment is used by ${attachedApps.length} app(s): ${names}. Reassign them first.`,
      }, { status: 409, headers: corsHeaders });
    }
    db.deleteEnvironment(id);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetEnvironmentApps(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "environments.view", envScope(id));
    const env = db.getEnvironment(id);
    if (!env) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const apps = db.getAppsByEnvironmentId(id).map((a) => ({
      id: a.id, name: a.name, status: a.status, domain: a.domain,
    }));
    return Response.json(apps, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAttachAppToEnvironment(request: Request, id: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "environments.manage", envScope(id));
    const env = db.getEnvironment(id);
    if (!env) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json();
    const { app_id } = body;
    const app = db.getApp(app_id);
    if (!app) {
      return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    db.updateAppEnvironment(app_id, id);
    // Redeploy the app with the new environment. The engine serializes on
    // `app:${app_id}` so this waits behind any in-flight op for the same app.
    let opId: number | null = null;
    if (app.status !== "stopped" && app.status !== "destroying") {
      const r = enqueue({
        kind: "redeploy",
        resourceKeys: [`app:${app_id}`],
        input: { appId: app_id, userId: payload.userId },
        trigger: "ui",
        triggeredBy: payload.userId,
      });
      opId = r.opId;
    }
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDetachAppFromEnvironment(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "environments.manage", envScope(id));
    const body = await request.json();
    const { app_id } = body;
    const app = db.getApp(app_id);
    if (!app) {
      return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    if (app.environment_id !== id) {
      return Response.json({ ok: false, error: "App is not attached to this environment" }, { status: 400, headers: corsHeaders });
    }
    db.updateAppEnvironment(app_id, null);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
