import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { findActiveOperationByResourceKey } from "../../shared/db/operations.ts";

// --- Deploy ---

export async function handleDeployStack(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.deploy");
    const req: StackDeployRequest = await request.json();
    if (!req?.name || typeof req.name !== "string") {
      return Response.json({ ok: false, error: "name is required" }, { status: 400, headers: corsHeaders });
    }
    // Single-flight: only one deploy_stack per stack may run at a time. If one is
    // already in flight (pending/running/compensating), attach to it — follow the
    // existing run — instead of enqueuing a duplicate.
    const resourceKey = `stack:${req.name}`;
    const existing = findActiveOperationByResourceKey("deploy_stack", resourceKey);
    if (existing) {
      return Response.json({ op_id: existing.id, attached: true }, { headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy_stack",
      resourceKeys: [`stack:${req.name}`],
      input: req,
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetStacks(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    const stacks = db.getStacks();
    const result = stacks.map((s) => ({
      ...s,
      app_count: db.getAppsByStackId(s.id).length,
      service_count: db.getServicesByStackId(s.id).length,
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Detail ---

export async function handleGetStack(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json({
      ...stack,
      apps: db.getAppsByStackId(stackId),
      services: db.getServicesByStackId(stackId),
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Log ---

export async function handleGetStackLog(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    return Response.json({ log: db.getStackLog(stackId) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.destroy");
    await enforceConfirmation(request, payload, "delete_stack", "stack", String(stackId));
    const { opId } = enqueue({ kind: "destroy_stack", resourceKeys: [`stack:${stackId}`], input: { stackId }, trigger: "ui", triggeredBy: payload.userId });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// Redeploy every app in the stack. A stack owns a shared environment, so this
// reuses the existing cascade_redeploy op (fan-out of per-app redeploys keyed
// on the environment) rather than introducing a stack-specific redeploy kind —
// exactly the op handleUpdateEnvironment enqueues when env vars change.
export async function handleRedeployStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.deploy");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    if (!stack.environment_id) {
      return Response.json({ ok: false, error: "Stack has no environment to redeploy" }, { status: 400, headers: corsHeaders });
    }
    const apps = db.getAppsByStackId(stackId);
    if (apps.length === 0) {
      return Response.json({ ok: false, error: "Stack has no apps to redeploy" }, { status: 400, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "cascade_redeploy",
      resourceKeys: [`env:${stack.environment_id}`],
      input: { environmentId: stack.environment_id },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
