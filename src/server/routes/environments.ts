import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { parseEnvVars, maskEnvVarsForResponse, serializeEnvVars, mergeEnvVarUpdate, processIncomingEnvVars } from "../../bun/env-crypto.ts";

export async function handleGetEnvironments(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
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
    await requirePermission(request, "admin");
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
    await requirePermission(request, "admin");
    const existing = db.getEnvironment(id);
    if (!existing) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json();
    const { name, env_vars } = body;
    const existingParsed = parseEnvVars(existing.env_vars);
    const merged = await mergeEnvVarUpdate(existingParsed, env_vars || []);
    db.updateEnvironment(id, name || existing.name, serializeEnvVars(merged.entries));
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteEnvironment(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "admin");
    const env = db.getEnvironment(id);
    if (!env) {
      return Response.json({ ok: false, error: "Environment not found" }, { status: 404, headers: corsHeaders });
    }
    db.deleteEnvironment(id);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
