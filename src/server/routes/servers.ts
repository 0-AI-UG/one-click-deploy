import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { destroyServer, getServersWithApps } from "../../bun/deploy/index.ts";

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
    const result = await destroyServer(serverId);
    return Response.json(result, { headers: corsHeaders });
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
