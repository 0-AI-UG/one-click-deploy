import { appStorageView } from "../../shared/object-storage.ts";
import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireAuthenticated, envScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { parseEnvVars, maskEnvVarsForResponse, serializeEnvVars, mergeEnvVarUpdate, processIncomingEnvVars, suspiciousPlaintextKeys, platformEnvVars, resolveAppEnvVars, SECRET_MASK } from "../../shared/env-crypto.ts";
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

export async function handleGetDeletedEnvironments(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "environments.view");
    const result = db.getDeletedEnvironments().map((environment) => ({
      ...environment,
      env_vars: maskEnvVarsForResponse(parseEnvVars(environment.env_vars)),
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
    const deleted = db.getDeletedEnvironments().find((e) => e.name === name.trim());
    if (existing || deleted) {
      return Response.json({
        ok: false,
        error: deleted
          ? "A deleted environment has that name; restore or permanently purge it first"
          : "An environment with that name already exists",
      }, { status: 409, headers: corsHeaders });
    }
    const warnings = suspiciousPlaintextKeys(env_vars || []);
    const processed = await processIncomingEnvVars(env_vars || []);
    const env = db.insertEnvironment(name.trim(), serializeEnvVars(processed.entries));
    return Response.json({
      ...env,
      env_vars: maskEnvVarsForResponse(parseEnvVars(env.env_vars)),
      warnings: warnings.map((key) => `${key} looked sensitive and was stored as an encrypted secret automatically.`),
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
    const body = await request.json() as {
      name?: string;
      env_vars?: Array<{ key: string; value: string; secret: boolean }>;
      rollout?: "redeploy" | "restart" | "none";
      app_ids?: number[];
      dry_run?: boolean;
    };
    const { name, env_vars } = body;
    const rollout = body.rollout ?? "redeploy";
    if (!["redeploy", "restart", "none"].includes(rollout)) {
      return Response.json(
        { ok: false, error: "rollout must be redeploy, restart, or none" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return Response.json(
        { ok: false, error: "dry_run must be a boolean" },
        { status: 400, headers: corsHeaders },
      );
    }

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
    let changedKeys: string[] = [];
    const warnings = env_vars === undefined ? [] : suspiciousPlaintextKeys(env_vars);
    if (env_vars !== undefined) {
      const existingParsed = parseEnvVars(existing.env_vars);
      const merged = await mergeEnvVarUpdate(existingParsed, env_vars || []);
      newSerialized = serializeEnvVars(merged.entries);
      const before = new Map(existingParsed.entries.map((entry) => [entry.key, JSON.stringify(entry)]));
      const after = new Map(merged.entries.map((entry) => [entry.key, JSON.stringify(entry)]));
      changedKeys = [...new Set([...before.keys(), ...after.keys()])]
        .filter((key) => before.get(key) !== after.get(key));
    }
    const attachedApps = db.getAppsByEnvironmentId(id);
    if (body.app_ids !== undefined && !Array.isArray(body.app_ids)) {
      return Response.json(
        { ok: false, error: "app_ids must be an array" },
        { status: 400, headers: corsHeaders },
      );
    }
    const requestedIds = body.app_ids === undefined ? null : new Set(body.app_ids.map(Number));
    if (requestedIds && [...requestedIds].some((appId) => !attachedApps.some((app) => app.id === appId))) {
      return Response.json(
        { ok: false, error: "app_ids may only contain apps linked to this environment" },
        { status: 400, headers: corsHeaders },
      );
    }
    const envVarsChanged = newSerialized !== existing.env_vars;
    // Calculate the impact before mutating desired state. A null projection is
    // the legacy "all keys" behavior; explicit projections prevent unrelated
    // stack members from becoming stale.
    const staleAppRows = envVarsChanged ? attachedApps
      .filter((app) => {
        const projection = db.parseAppEnvProjection(app);
        return projection === null || projection.some((key) => changedKeys.includes(key));
      }) : [];
    const affectedApps = staleAppRows.filter((app) => !requestedIds || requestedIds.has(app.id));
    const appSummary = (app: typeof attachedApps[number]) => ({ id: app.id, name: app.name });

    if (body.dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        rollout,
        changed_keys: changedKeys,
        stale_apps: staleAppRows.map(appSummary),
        affected_apps: affectedApps.map(appSummary),
        warnings: warnings.map((key) => `${key} looked sensitive and would be stored as an encrypted secret automatically.`),
      }, { headers: corsHeaders });
    }

    db.updateEnvironment(id, name || existing.name, newSerialized);
    const staleApps = envVarsChanged
      ? db.markAppsEnvironmentStaleForKeys(id, changedKeys)
      : 0;
    let opId: number | null = null;
    if (envVarsChanged && rollout !== "none" && affectedApps.length > 0) {
      const r = enqueue({
        kind: "cascade_redeploy",
        resourceKeys: [`env:${id}`],
        input: {
          environmentId: id,
          appIds: affectedApps.map((app) => app.id),
          changedKeys,
          mode: rollout,
        },
        trigger: payload.client === "cli" ? "cli" : "ui",
        triggeredBy: payload.userId,
      });
      opId = r.opId;
    }

    return Response.json({
      ok: true,
      redeploying: envVarsChanged && rollout === "redeploy" ? affectedApps.length : 0,
      restarting: envVarsChanged && rollout === "restart" ? affectedApps.length : 0,
      affected: envVarsChanged ? affectedApps.length : 0,
      affected_apps: envVarsChanged ? affectedApps.map(appSummary) : [],
      stale_app_details: envVarsChanged ? staleAppRows.map(appSummary) : [],
      stale_apps: staleApps,
      rollout,
      changed_keys: changedKeys,
      warnings: warnings.map((key) => `${key} looked sensitive and was stored as an encrypted secret automatically.`),
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
    if (db.getEnvironments().some((e) => e.name === name) || db.getDeletedEnvironments().some((e) => e.name === name)) {
      return Response.json({ ok: false, error: "An active or deleted environment with that name already exists" }, { status: 409, headers: corsHeaders });
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
    db.softDeleteEnvironment(id);
    const deleted = db.getDeletedEnvironment(id);
    return Response.json({
      ok: true,
      recoverable: true,
      recoverable_until: deleted?.purge_after ?? null,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestoreEnvironment(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "environments.manage", envScope(id));
    const environment = db.getDeletedEnvironment(id);
    if (!environment) {
      return Response.json({ ok: false, error: "Deleted environment not found" }, { status: 404, headers: corsHeaders });
    }
    db.restoreEnvironment(id);
    const restored = db.getEnvironment(id)!;
    return Response.json({
      ...restored,
      env_vars: maskEnvVarsForResponse(parseEnvVars(restored.env_vars)),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePurgeEnvironment(request: Request, id: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "environments.manage", envScope(id));
    const environment = db.getDeletedEnvironment(id);
    if (!environment) {
      return Response.json({ ok: false, error: "Deleted environment not found" }, { status: 404, headers: corsHeaders });
    }
    if (db.isEnvironmentPurgeProtected(environment) && payload.client === "cli") {
      return Response.json(
        {
          ok: false,
          error: `Environment is protected from permanent deletion until ${environment.purge_after} UTC. The recovery window can only be overridden with the Purge button in the OCD web UI.`,
          purge_after: environment.purge_after,
        },
        { status: 409, headers: corsHeaders },
      );
    }
    await enforceConfirmation(request, payload, "purge_environment", "environment", String(id));
    db.deleteEnvironment(id);
    return Response.json({ ok: true, permanently_deleted: true }, { headers: corsHeaders });
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
    const apps = await Promise.all(db.getAppsByEnvironmentId(id).map(async (a) => {
      const resolved = await resolveAppEnvVars(a);
      const secretKeys = new Set(parseEnvVars(env.env_vars).entries.filter((entry) => entry.secret).map((entry) => entry.key));
      return {
        id: a.id, name: a.name, status: a.status, domain: a.domain,
        storage_bindings: appStorageView(a.id),
        runtime_env_vars: Object.keys(platformEnvVars(a)).map((key) => ({
          key,
          value: secretKeys.has(key) && key !== "OCD_DEPLOY_TARGET" ? SECRET_MASK : resolved[key],
          secret: secretKeys.has(key) && key !== "OCD_DEPLOY_TARGET",
          injected_by: "OCD",
        })).concat(appStorageView(a.id).flatMap(binding => [
          { key: binding.variables.token, value: SECRET_MASK, secret: true, injected_by: `Object storage · ${binding.name}` },
          { key: binding.variables.url, value: resolved[binding.variables.url], secret: false, injected_by: `Object storage · ${binding.name}` },
        ])),
      };
    }));
    return Response.json(apps, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
