// Panel (hosted self) routes. Deliberately minimal: view state, redeploy,
// view logs, view deployment history. No scale, no env editing, no delete.
import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { redeployPanel, getPanelContainerLogs } from "../../engine/deploy/panel.ts";
import { reconcilePanelDns } from "../../engine/dns-reconciler.ts";

export async function handleGetPanel(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "panel.view");
    const panel = db.getPanel();
    if (!panel) {
      return Response.json({ panel: null }, { headers: corsHeaders });
    }
    const {
      env_vars: _envVars,
      ...safePanel
    } = panel;
    const server = db.getServer(panel.server_id);
    return Response.json(
      {
        panel: safePanel,
        server: server || null,
        deploy_log: db.getPanelDeployLog(),
        dns_instruction: await reconcilePanelDns(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployPanel(request: Request): Promise<Response> {
  try {
    // Redeploying the control plane itself — governed by its own grant, not by
    // any app-level permission.
    await requirePermission(request, "panel.manage");
    const body = await request.json() as { image?: string; commit?: string };
    if (!body.image) {
      return Response.json({ ok: false, error: "image is required" }, { status: 400, headers: corsHeaders });
    }
    const result = await redeployPanel((_step, _detail) => {
      // Progress goes to logs; no SSE for the minimal panel UI.
    }, { image: body.image, commit: body.commit, source: "release" });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelLogs(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "panel.view");
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
    await requirePermission(request, "panel.view");
    const deployments = db.getPanelDeployments();
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
