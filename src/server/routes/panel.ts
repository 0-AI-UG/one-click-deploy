// Panel (hosted self) routes. Deliberately minimal: view state, redeploy,
// view logs, view deployment history. No scale, no env editing, no delete.
import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { redeployPanel, getPanelContainerLogs } from "../../bun/deploy/panel.ts";

export async function handleGetPanel(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const panel = db.getPanel();
    if (!panel) {
      return Response.json({ panel: null }, { headers: corsHeaders });
    }
    const server = db.getServer(panel.server_id);
    return Response.json(
      {
        panel,
        server: server || null,
        deploy_log: db.getPanelDeployLog(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployPanel(request: Request): Promise<Response> {
  try {
    // Redeploying the panel is an admin-level action — reuse the most
    // privileged perm we already have.
    await requirePermission(request, "apps.redeploy");
    const result = await redeployPanel((_step, _detail) => {
      // Progress goes to logs; no SSE for the minimal panel UI.
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelLogs(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const url = new URL(request.url);
    const tail = parseInt(url.searchParams.get("tail") || "200", 10);
    const logs = await getPanelContainerLogs(tail);
    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelDeployments(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const deployments = db.getPanelDeployments();
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
