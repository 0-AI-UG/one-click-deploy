import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { enrichAppForResponse } from "./apps.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";

/** Scrub each server's app rows through enrichAppForResponse so secrets never
 *  leak from the server-overview endpoints (same guarantee as /api/apps). */
function scrubServersWithApps(servers: any[]): any[] {
  return servers.map((s) => ({ ...s, apps: (s.apps || []).map((a: any) => enrichAppForResponse(a)) }));
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteServer(request: Request, serverId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "servers.delete");
    if (!db.getServer(serverId)) {
      return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "delete_server", "server", String(serverId));
    const apps = db.getApps(serverId);
    const services = db.getServicesOnServer(serverId);
    const keys = [
      `server:${serverId}`,
      ...apps.map((a) => `app:${a.id}`),
      ...services.map((s) => `service:${s.id}`),
    ];
    const { opId } = enqueue({
      kind: "destroy_server",
      resourceKeys: keys,
      input: { serverId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** PATCH /api/servers/:id/pool — move a server into a named capacity pool.
 *  Governs FUTURE placement only (next deploy/scale/converge); replicas already
 *  running on the server stay put — no active migration here. */
export async function handleSetServerPool(request: Request, serverId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.manage");
    const body = (await request.json().catch(() => ({}))) as { pool?: unknown };
    const pool = body.pool;

    const server = db.getServer(serverId);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { status: 404, headers: corsHeaders });

    if (typeof pool !== "string" || pool.length > 32 || !/^[a-z][a-z0-9-]*$/.test(pool)) {
      return Response.json(
        { ok: false, error: "pool must be a lowercase slug (letters, digits, hyphens; e.g. general or staging)" },
        { status: 400, headers: corsHeaders },
      );
    }

    db.updateServerPool(serverId, pool);
    return Response.json({ ok: true, pool }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRefreshServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
