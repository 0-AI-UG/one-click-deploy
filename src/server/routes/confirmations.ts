import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import {
  createConfirmation,
  pollConfirmation,
  getPendingForUser,
  resolveConfirmation,
} from "../lib/action-confirm.ts";

const CONFIRMABLE_ACTIONS = ["delete_app", "delete_stack", "delete_environment"] as const;
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
      return Response.json({ error: "action must be one of delete_app, delete_stack, delete_environment" }, { status: 400, headers: corsHeaders });
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
      summary = `Destroy app "${app.name}" (id ${app.id}) — removes its container(s), DNS records, and any managed volumes.`;
    } else if (action === "delete_stack") {
      const s = db.getStack(Number(resourceId));
      if (!s) return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
      const apps = db.getAppsByStackId(s.id);
      const svcs = db.getServicesByStackId(s.id);
      summary = `Destroy stack "${s.name}" and all ${apps.length} app(s) + ${svcs.length} service(s).`;
    } else {
      const env = db.getEnvironment(Number(resourceId));
      if (!env) return Response.json({ error: "Environment not found" }, { status: 404, headers: corsHeaders });
      const inUse = db.getAppsByEnvironmentId(env.id);
      summary = inUse.length
        ? `Delete environment "${env.name}" (id ${env.id}) — currently used by ${inUse.length} app(s).`
        : `Delete environment "${env.name}" (id ${env.id}) and its variables.`;
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

    return Response.json({ action: pending.action, summary: pending.summary }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// POST /api/confirmations/item/:userCode/confirm — called by web UI (requires auth).
export async function handleConfirmConfirmation(request: Request, userCode: string): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);

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
