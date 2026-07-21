import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { findActiveOperationByResourceKey } from "../../shared/db/operations.ts";
import { getContainerLogs } from "../../shared/remote/index.ts";

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
    const result = stacks.map((s) => {
      const apps = db.getAppsByStackId(s.id);
      return {
        ...s,
        app_count: apps.length,
        service_count: db.getServicesByStackId(s.id).length,
        // How many members `promote_stack` would actually promote. This applies
        // the SAME three rules as planPromotions (production row + staging on +
        // a sibling holding a deployed commit) so the dashboard button and the
        // CLI pre-check can't offer a promote the op then rejects.
        staging_sibling_count: apps.filter((a) => {
          if (a.target_of != null || a.webhook_staging_environment_id == null) return false;
          const sibling = db.getStagingSibling(a.id);
          return sibling != null && db.getDeployedCommit(sibling.id) != null;
        }).length,
      };
    });
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

// --- Settings ---

// The only mutable stack-level setting: the shared staging environment. A stack
// owns exactly ONE, and no member may override it (deploy_stack overwrites the
// per-app column on every run), so re-pointing it here means re-pointing every
// member that currently has staging on.
//
// Deliberately NOT settable: `name` (it prefixes every member app/service,
// container and op resource key) and `environment_id` (members carry their own
// copy; re-pointing it is a redeploy of the whole stack, which `deploy_stack`
// already does properly via a re-up).
export async function handleUpdateStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.deploy");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json() as { staging_environment_id?: number | null };
    if (!("staging_environment_id" in body)) {
      return Response.json({ ok: false, error: "staging_environment_id is required" }, { status: 400, headers: corsHeaders });
    }
    const next = body.staging_environment_id ?? null;
    if (next != null) {
      if (typeof next !== "number" || !db.getEnvironment(next)) {
        return Response.json({ ok: false, error: `Staging environment ${next} not found` }, { status: 400, headers: corsHeaders });
      }
      if (next === stack.environment_id) {
        return Response.json(
          { ok: false, error: "Staging environment must differ from the stack's production environment" },
          { status: 400, headers: corsHeaders },
        );
      }
    }
    db.updateStackStagingEnvironment(stackId, next);
    // Push down to members. Staging opt-in itself is manifest intent
    // (webhook.staging) which we never persist, so we can only re-point members
    // that ALREADY have staging on — clearing turns it off everywhere, and
    // turning it on for a new member still requires a stack re-up.
    let repointed = 0;
    for (const app of db.getAppsByStackId(stackId)) {
      if (app.target_of != null) continue; // staging siblings are not members in their own right
      if ((app.webhook_staging_environment_id ?? null) == null) continue;
      db.updateAppWebhookStagingEnvironment(app.id, next);
      repointed++;
    }
    db.appendStackLog(
      stackId,
      next == null
        ? `[settings] staging environment cleared — staging disabled on ${repointed} member(s)`
        : `[settings] staging environment → ${next} (${repointed} member(s) re-pointed)`,
    );
    return Response.json({ ok: true, staging_environment_id: next, members_updated: repointed, updated_by: payload.userId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Membership ---
//
// Membership is a single nullable column (apps.stack_id / services.stack_id), so
// attach/detach is metadata only: nothing is rebuilt, moved, or destroyed. A
// detached app keeps its containers, env and domain and simply reappears at the
// dashboard's top level. This is the escape hatch for the declarative path — the
// authoritative way to change membership is still editing `ocd-stack.json` and
// re-running the stack deploy.

function memberPartsFrom(request: Request): { kind: string; id: number } {
  const m = new URL(request.url).pathname.match(/\/members\/(apps|services)\/(\d+)$/);
  return m ? { kind: m[1], id: parseInt(m[2], 10) } : { kind: "", id: 0 };
}

export async function handleAddStackMember(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.deploy");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const body = await request.json() as { kind?: string; id?: number };
    const id = Number(body?.id);
    if (!id || (body.kind !== "app" && body.kind !== "service")) {
      return Response.json({ ok: false, error: 'kind must be "app" or "service" and id is required' }, { status: 400, headers: corsHeaders });
    }
    if (body.kind === "app") {
      const app = db.getApp(id);
      if (!app) return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
      if (app.target_of != null) {
        return Response.json({ ok: false, error: "Staging siblings follow their production app and cannot be added directly" }, { status: 400, headers: corsHeaders });
      }
      if (app.stack_id != null && app.stack_id !== stackId) {
        return Response.json({ ok: false, error: `App already belongs to stack ${app.stack_id}` }, { status: 409, headers: corsHeaders });
      }
      db.setAppStack(id, stackId);
      db.appendStackLog(stackId, `[members] added app "${app.name}" (${id})`);
    } else {
      const svc = db.getService(id);
      if (!svc) return Response.json({ ok: false, error: "Service not found" }, { status: 404, headers: corsHeaders });
      if (svc.stack_id != null && svc.stack_id !== stackId) {
        return Response.json({ ok: false, error: `Service already belongs to stack ${svc.stack_id}` }, { status: 409, headers: corsHeaders });
      }
      db.setServiceStack(id, stackId);
      db.appendStackLog(stackId, `[members] added service "${svc.name}" (${id})`);
    }
    return Response.json({ ok: true, added_by: payload.userId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRemoveStackMember(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.deploy");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const { kind, id } = memberPartsFrom(request);
    if (!id || !kind) {
      return Response.json({ ok: false, error: "Invalid member path" }, { status: 400, headers: corsHeaders });
    }
    if (kind === "apps") {
      const app = db.getApp(id);
      if (!app || app.stack_id !== stackId) {
        return Response.json({ ok: false, error: "App is not a member of this stack" }, { status: 404, headers: corsHeaders });
      }
      db.setAppStack(id, null);
      db.appendStackLog(stackId, `[members] detached app "${app.name}" (${id}) — containers left running`);
    } else {
      const svc = db.getService(id);
      if (!svc || svc.stack_id !== stackId) {
        return Response.json({ ok: false, error: "Service is not a member of this stack" }, { status: 404, headers: corsHeaders });
      }
      db.setServiceStack(id, null);
      db.appendStackLog(stackId, `[members] detached service "${svc.name}" (${id}) — container left running`);
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
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

/**
 * GET /api/stacks/:id/member-logs?tail=N — container logs of every member, in
 * one round trip.
 *
 * A stack is only interesting as a whole: a request crosses three of its apps
 * and a database, so reading one member's log at a time is the wrong unit. We
 * fan out over the members' primary replica / instance, ask docker for
 * timestamped lines, and hand the client one block per member. Interleaving and
 * per-member filtering happen client-side so toggling a member off is instant
 * and doesn't re-run N ssh calls.
 *
 * Gated on `apps.logs` on top of `stacks.view`: this returns container output,
 * which is strictly more than the stack metadata `stacks.view` covers.
 */
export async function handleGetStackMemberLogs(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    await requirePermission(request, "apps.logs");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const tail = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("tail") || "100", 10) || 100, 1), 1000);

    // Staging siblings follow their production app and are not members in their
    // own right — the same rule the detail page's member list uses.
    const apps = db.getAppsByStackId(stackId).filter((a) => a.target_of == null);
    const services = db.getServicesByStackId(stackId);

    const fetchApp = async (app: { id: number; name: string }) => {
      const replicas = db.getReplicas(app.id);
      if (replicas.length === 0) throw new Error("No replicas");
      const replica = replicas[0];
      const server = db.getServer(replica.server_id);
      if (!server) throw new Error("Server not found");
      return getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined, true);
    };

    const fetchService = async (service: { id: number; name: string }) => {
      const instance = db.getPrimaryInstance(service.id);
      if (!instance) throw new Error("No primary instance");
      const server = db.getServer(instance.server_id);
      if (!server) throw new Error("Server not found");
      return getContainerLogs(server.ipv4, instance.container_name, tail, server.ssh_host_key || undefined, true);
    };

    // One slow or unreachable member must not blank the whole view, so each
    // failure is reported in its own block and the rest still render.
    const members = await Promise.all([
      ...apps.map(async (a) => {
        try {
          return { kind: "app" as const, id: a.id, name: a.name, logs: await fetchApp(a) };
        } catch (err) {
          return { kind: "app" as const, id: a.id, name: a.name, logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      }),
      ...services.map(async (s) => {
        try {
          return { kind: "service" as const, id: s.id, name: s.name, logs: await fetchService(s) };
        } catch (err) {
          return { kind: "service" as const, id: s.id, name: s.name, logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ]);

    return Response.json({ members }, { headers: corsHeaders });
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

// Promote every stack member that has a webhook-staging sibling holding a
// deployed commit. Fans out to the per-app `promote` op; member selection (and
// the "nothing to promote" error) lives in the promote_stack op itself so the
// CLI and the UI get identical behaviour.
export async function handlePromoteStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.deploy");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "promote_stack",
      // Both key shapes on purpose: `stack:<id>` serializes against
      // destroy_stack, `stack:<name>` against deploy_stack (which keys on the
      // name). Without the name key a concurrent stack deploy would enqueue a
      // `redeploy` on the same member as our `promote`, and if the redeploy
      // landed last production would sit on branch HEAD, not the promoted commit.
      resourceKeys: [`stack:${stackId}`, `stack:${stack.name}`],
      input: { stackId, userId: payload.userId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
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
