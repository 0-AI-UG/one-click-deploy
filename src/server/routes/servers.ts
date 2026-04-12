import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { destroyServer, getServersWithApps } from "../../bun/deploy/index.ts";
import * as db from "../../bun/db.ts";
import { tryAcquireMulti } from "../../bun/op-lock.ts";

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const result = getServersWithApps();
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteServer(request: Request, serverId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.delete");
    const apps = db.getApps(serverId);
    const services = db.getServicesOnServer(serverId);
    const keys = [
      `server:${serverId}`,
      ...apps.map((a) => `app:${a.id}`),
      ...services.map((s) => `service:${s.id}`),
    ];
    const lock = tryAcquireMulti(keys, "destroyServer");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `Server has a busy resource: ${lock.holder} on ${lock.resourceKey}` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await destroyServer(serverId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRefreshServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const result = getServersWithApps();
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
