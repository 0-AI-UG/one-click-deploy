import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";

export async function handleGetDeploySession(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const data = db.getDeploySession(payload.userId);
    if (!data) return Response.json({ session: null }, { headers: corsHeaders });
    return Response.json({ session: JSON.parse(data) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSaveDeploySession(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const body = await request.json();
    db.saveDeploySession(payload.userId, JSON.stringify(body));
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteDeploySession(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    db.deleteDeploySession(payload.userId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
