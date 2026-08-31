import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { getOperation } from "../../shared/db/operations.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { parseServerProvisioningResourceId } from "../../shared/server-provisioning.ts";
import {
  createConfirmation,
  pollConfirmation,
  getPendingForUser,
  resolveConfirmation,
} from "../lib/action-confirm.ts";

const CONFIRMABLE_ACTIONS = [
  "delete_app",
  "delete_server",
  "delete_stack",
  "delete_environment",
  "purge_environment",
  "delete_volume",
  "cancel_operation",
  "create_server",
  "promote_app",
  "promote_stack",
] as const;
type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];

// POST /api/confirmations — called by CLI (requires auth) to open a pending
// destructive-action confirmation the user must approve in the browser. The
// summary shown to the user is built here, server-side, from the real resource
// — the CLI does not get to describe what it's about to destroy.
export async function handleCreateConfirmation(request: Request): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const body = (await request.json()) as {
      action?: string;
      resource_type?: string;
      resource_id?: string | number;
    };

    if (
      typeof body.action !== "string" ||
      !CONFIRMABLE_ACTIONS.includes(body.action as ConfirmableAction)
    ) {
      return Response.json({ error: `action must be one of ${CONFIRMABLE_ACTIONS.join(", ")}` }, { status: 400, headers: corsHeaders });
    }
    if (
      typeof body.resource_type !== "string" ||
      !body.resource_type ||
      body.resource_id === undefined ||
      body.resource_id === null ||
      body.resource_id === ""
    ) {
      return Response.json({ error: "resource_type and resource_id are required" }, { status: 400, headers: corsHeaders });
    }

    const action = body.action as ConfirmableAction;
    const resourceType = body.resource_type;
    const resourceId = String(body.resource_id);

    let summary: string;
    if (action === "delete_app") {
      const app = db.getApp(Number(resourceId));
      if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
      summary = `Destroy app "${app.name}" (id ${app.id}) — removes its container(s); managed volumes are detached and retained for recovery. DNS is never changed, so remove ${app.domain || "its record"} manually if needed.`;
    } else if (action === "delete_server") {
      const server = db.getServers().find((row) => String(row.id) === resourceId || row.provider_id === resourceId);
      if (!server) return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
      const apps = db.getApps(server.id);
      summary = server.ownership === "connected"
        ? `Disconnect externally owned server "${server.name}" (id ${server.id}) after destroying ${apps.length} app(s) assigned to it. The VPS itself will not be changed or deleted.`
        : `Permanently delete managed server "${server.name}" (${server.provider_id || `id ${server.id}`}) and destroy ${apps.length} app(s) assigned to it.`;
    } else if (action === "delete_stack") {
      const s = db.getStack(Number(resourceId));
      if (!s) return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
      const apps = db.getAppsByStackId(s.id);
      summary = `Destroy stack "${s.name}" and all ${apps.length} app(s); its production and staging environments are retained, and managed volumes are detached for recovery.`;
    } else if (action === "delete_environment") {
      const env = db.getEnvironment(Number(resourceId));
      if (!env) return Response.json({ error: "Environment not found" }, { status: 404, headers: corsHeaders });
      const inUse = db.getAppsByEnvironmentId(env.id);
      summary = inUse.length
        ? `Retire environment "${env.name}" (id ${env.id}) — currently used by ${inUse.length} app(s).`
        : `Retire environment "${env.name}" (id ${env.id}) for seven-day recovery.`;
    } else if (action === "purge_environment") {
      const env = db.getDeletedEnvironment(Number(resourceId));
      if (!env) return Response.json({ error: "Deleted environment not found" }, { status: 404, headers: corsHeaders });
      if (payload.client === "cli" && db.isEnvironmentPurgeProtected(env)) {
        return Response.json(
          {
            error: `Environment is protected from permanent deletion until ${env.purge_after} UTC. The recovery window can only be overridden with the Purge button in the OCD web UI.`,
            purge_after: env.purge_after,
          },
          { status: 409, headers: corsHeaders },
        );
      }
      summary = `Permanently delete retired environment "${env.name}" (id ${env.id}) and all its variables. This cannot be undone.`;
    } else if (action === "delete_volume") {
      let volume;
      try {
        volume = await hetzner.volumes.get(resourceId);
      } catch {
        return Response.json({ error: "Volume not found" }, { status: 404, headers: corsHeaders });
      }
      summary =
        `Permanently delete provider volume "${volume.name}" (id ${volume.providerId}, ` +
        `${volume.sizeGb} GB, ${volume.location}) and all data on it. This cannot be undone.`;
    } else if (action === "create_server") {
      if (resourceType !== "server_plan") {
        return Response.json({ error: "create_server requires a server_plan resource" }, { status: 400, headers: corsHeaders });
      }
      const plan = parseServerProvisioningResourceId(resourceId);
      if (!plan) return Response.json({ error: "Invalid server provisioning plan" }, { status: 400, headers: corsHeaders });
      summary =
        `Allow creation of one or more billable provider servers as required for ${plan.reason}: ` +
        `${plan.serverType} in ${plan.location}, pool${plan.pools.length === 1 ? "" : "s"} ${plan.pools.join(", ")}.`;
    } else if (action === "promote_app") {
      const match = /^(\d+):(\d+)$/.exec(resourceId);
      const source = match ? db.getApp(Number(match[1])) : null;
      const destination = match ? db.getApp(Number(match[2])) : null;
      if (!source || !destination) return Response.json({ error: "Promotion apps not found" }, { status: 404, headers: corsHeaders });
      const commit = db.getDeployments(source.id).find((deployment) => deployment.status === "deployed")?.git_commit;
      summary = `Promote ${source.name}${commit ? ` at commit ${commit}` : ""} to production app ${destination.name}, replacing its running deployment.`;
    } else if (action === "promote_stack") {
      const stack = db.getStack(Number(resourceId));
      if (!stack) return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
      summary = `Promote every ready staging sibling in stack "${stack.name}" to production, replacing the affected production deployments.`;
    } else {
      const op = getOperation(Number(resourceId));
      if (!op) return Response.json({ error: "Operation not found" }, { status: 404, headers: corsHeaders });
      const { previewCompensation } = await import("../../engine/compensation-safety.ts");
      summary = previewCompensation(op).summary;
    }

    const { confirmCode, userCode, expiresIn } = await createConfirmation(payload, action, resourceType, resourceId, summary);
    return Response.json({ confirm_code: confirmCode, user_code: userCode, expires_in: expiresIn, summary }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// POST /api/confirmations/poll — polled by CLI (requires auth) for the result.
export async function handlePollConfirmation(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const body = (await request.json()) as { confirm_code?: string };

    if (!body.confirm_code) {
      return Response.json({ error: "confirm_code is required" }, { status: 400, headers: corsHeaders });
    }

    const result = pollConfirmation(body.confirm_code);
    return Response.json({ status: result.status }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// GET /api/confirmations/item/:userCode — called by web UI (requires auth) to
// show what the user is being asked to confirm.
export async function handleLookupConfirmation(request: Request, userCode: string): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);

    const pending = getPendingForUser(userCode, payload);
    if (!pending) {
      return Response.json({ error: "Confirmation not found or expired" }, { status: 404, headers: corsHeaders });
    }

    const resourceName = pending.action === "purge_environment"
      ? db.getDeletedEnvironment(Number(pending.resourceId))?.name
      : undefined;

    return Response.json({
      action: pending.action,
      summary: pending.summary,
      resource_type: pending.resourceType,
      resource_id: pending.resourceId,
      ...(resourceName ? { resource_name: resourceName } : {}),
    }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// POST /api/confirmations/item/:userCode/confirm — called by web UI (requires auth).
export async function handleConfirmConfirmation(request: Request, userCode: string): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const pending = getPendingForUser(userCode, payload);
    if (!pending) {
      return Response.json({ error: "Confirmation not found or expired" }, { status: 400, headers: corsHeaders });
    }
    if (pending.action === "delete_volume") {
      const body = await request.json().catch(() => ({})) as { typed_resource_id?: string };
      if (body.typed_resource_id !== pending.resourceId) {
        return Response.json(
          { error: `Type volume ID ${pending.resourceId} to confirm permanent deletion` },
          { status: 400, headers: corsHeaders },
        );
      }
    } else if (pending.action === "purge_environment") {
      const environment = db.getDeletedEnvironment(Number(pending.resourceId));
      if (!environment) {
        return Response.json({ error: "Deleted environment not found" }, { status: 404, headers: corsHeaders });
      }
      const body = await request.json().catch(() => ({})) as { typed_resource_name?: string };
      if (body.typed_resource_name !== environment.name) {
        return Response.json(
          { error: `Type environment name ${environment.name} to confirm permanent deletion` },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    const ok = resolveConfirmation(userCode, payload, "confirmed");
    if (!ok) {
      return Response.json({ error: "Confirmation not found or expired" }, { status: 400, headers: corsHeaders });
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// POST /api/confirmations/item/:userCode/deny — called by web UI (requires auth).
export async function handleDenyConfirmation(request: Request, userCode: string): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);

    const ok = resolveConfirmation(userCode, payload, "denied");
    if (!ok) {
      return Response.json({ error: "Confirmation not found or expired" }, { status: 400, headers: corsHeaders });
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}
