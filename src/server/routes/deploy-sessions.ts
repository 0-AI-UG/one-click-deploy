import { corsHeaders } from "../lib/cors.ts";
import { requireOrgPermission } from "../lib/org-context.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

export async function handleGetDeploySession(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    const data = db.getDeploySession(ctx.userId, ctx.orgId);
    if (!data) return Response.json({ session: null }, { headers: corsHeaders });
    return Response.json({ session: JSON.parse(data) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSaveDeploySession(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    const body = await request.json();
    db.saveDeploySession(ctx.userId, JSON.stringify(body), ctx.orgId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteDeploySession(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgPermission(request, "apps.deploy");
    db.deleteDeploySession(ctx.userId, ctx.orgId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
