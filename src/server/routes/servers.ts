import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";

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
    const payload = await requirePermission(request, "servers.delete");
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
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
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
