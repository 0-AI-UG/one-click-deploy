import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import * as hetzner from "../../bun/hetzner/index.ts";
import * as github from "../../bun/github.ts";

export async function handleEnableWebhook(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "webhooks.manage");
    const body = await request.json() as { branch?: string };

    const app = db.getApp(appId);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    const server = db.getServer(app.server_id);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });

    const pat = await github.getGitHubPat();
    if (!pat) return Response.json({ ok: false, error: "GitHub token not configured. Add it in Settings." }, { headers: corsHeaders });

    const webhookBranch = body.branch || "main";
    const webhookSecret = crypto.randomUUID();
    const hostKey = server.ssh_host_key || undefined;

    await hetzner.deployWebhookReceiver(server.ipv4, hostKey);
    await hetzner.ensureWebhookCaddyRoute(server.ipv4, hostKey);
    await hetzner.setupAppWebhook(
      server.ipv4, app.name, webhookSecret,
      app.host_port, webhookBranch, pat, hostKey,
      app.deploy_mode, app.compose_file || undefined,
      app.container_port, app.volume_mount || undefined,
    );

    const webhook = await github.createWebhook({
      gitRepo: app.git_repo,
      appName: app.name,
      serverDomain: app.domain,
      webhookSecret,
      token: pat,
    });

    db.updateAppWebhook(appId, true, webhookSecret, webhookBranch, String(webhook.id));

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDisableWebhook(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "webhooks.manage");

    const app = db.getApp(appId);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    const server = db.getServer(app.server_id);

    if (app.github_webhook_id) {
      const pat = await github.getGitHubPat();
      if (pat) {
        try {
          await github.deleteWebhook({
            gitRepo: app.git_repo,
            webhookId: app.github_webhook_id,
            token: pat,
          });
        } catch {}
      }
    }

    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      await hetzner.removeAppWebhook(server.ipv4, app.name, hostKey);
    }

    db.updateAppWebhook(appId, false, "", app.webhook_branch || "main", "");

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
