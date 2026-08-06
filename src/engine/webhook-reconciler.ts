import * as db from "../shared/db.ts";
import * as github from "../shared/github.ts";
import { resolveGitHubToken } from "../shared/github-token.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [webhook-reconciler]`, ...args);
}

async function reconcileHook(opts: {
  gitRepo: string;
  desired: boolean;
  desiredId: string;
  desiredUrl: string;
  secret: string;
  token: string;
}): Promise<string> {
  const hooks = await github.listWebhooks({ gitRepo: opts.gitRepo, token: opts.token });
  const owned = hooks.filter((candidate) =>
    (!!opts.desiredId && String(candidate.id) === opts.desiredId) ||
    candidate.config?.url === opts.desiredUrl
  );
  if (!opts.desired) {
    for (const hook of owned) {
      await github.deleteWebhook({ gitRepo: opts.gitRepo, webhookId: String(hook.id), token: opts.token });
    }
    return "";
  }
  const hook = owned.find((candidate) => candidate.config?.url === opts.desiredUrl) ?? owned[0];
  if (!hook) {
    const created = await github.createWebhookAtUrl({
      gitRepo: opts.gitRepo,
      url: opts.desiredUrl,
      webhookSecret: opts.secret,
      token: opts.token,
    });
    return String(created.id);
  }
  if (!hook.active || hook.config?.url !== opts.desiredUrl || hook.config?.content_type !== "json") {
    await github.updateWebhookAtUrl({
      gitRepo: opts.gitRepo,
      webhookId: String(hook.id),
      url: opts.desiredUrl,
      webhookSecret: opts.secret,
      token: opts.token,
    });
  }
  // A crash after remote creation but before persisting its id can leave a
  // duplicate delivery. The endpoint URL is OCD-owned, so converge it to one.
  for (const duplicate of owned.filter((candidate) => candidate.id !== hook.id)) {
    await github.deleteWebhook({ gitRepo: opts.gitRepo, webhookId: String(duplicate.id), token: opts.token });
  }
  return String(hook.id);
}

export async function reconcileWebhooks(): Promise<void> {
  const panel = db.getPanel();
  if (!panel) return;
  for (const snapshot of db.getApps()) {
    const keys = [`app:${snapshot.id}`];
    const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:webhook");
    if (!lock.ok) continue;
    try {
      const token = await resolveGitHubToken(snapshot.deployed_by || undefined);
      const trackedRepo = snapshot.github_webhook_repo || snapshot.git_repo;
      if (!token || !trackedRepo.includes("github.com")) continue;
      const app = db.getApp(snapshot.id);
      if (!app) continue;
      const secret = app.webhook_secret || crypto.randomUUID();
      const desiredUrl = `https://${panel.domain}/webhooks/github/${app.id}`;
      let providerRepo = app.github_webhook_repo || app.git_repo;
      let providerId = app.github_webhook_id;

      // Repository changes are two independent desired-state transitions:
      // first prove absence in the old repo, then create/adopt in the new one.
      if (providerRepo !== app.git_repo) {
        await reconcileHook({
          gitRepo: providerRepo,
          desired: false,
          desiredId: providerId,
          desiredUrl,
          secret,
          token,
        });
        db.updateAppWebhookProviderIdentity(app.id, "", "");
        providerRepo = app.git_repo;
        providerId = "";
      }
      if (!providerRepo.includes("github.com")) {
        log(`${app.name}: webhook desired state requires a GitHub repository`);
        continue;
      }
      db.updateAppWebhookProviderIdentity(app.id, providerRepo);
      const id = await reconcileHook({
        gitRepo: providerRepo,
        desired: !!app.webhook_enabled && !app.deletion_requested_at && !!panel.domain,
        desiredId: providerId,
        desiredUrl,
        secret,
        token,
      });
      const configured = !!app.webhook_enabled;
      db.updateAppWebhookProviderIdentity(app.id, id ? providerRepo : "", id);
      if (id !== providerId || (configured && secret !== app.webhook_secret)) {
        db.updateAppWebhook(
          app.id,
          configured,
          configured ? secret : "",
          app.webhook_branch,
          id,
          app.webhook_path,
          !!app.webhook_wait_for_ci,
          !!app.webhook_staging,
        );
      }
    } catch (error) {
      log(`${snapshot.name}: ${error}`);
    } finally {
      release(keys);
    }
  }

  const freshPanel = db.getPanel();
  if (!freshPanel?.webhook_owner_user_id) return;
  const trackedPanelRepo = freshPanel.github_webhook_repo || freshPanel.git_repo;
  if (!trackedPanelRepo.includes("github.com")) return;
  const keys = [`server:${freshPanel.server_id}`];
  const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:panel-webhook");
  if (!lock.ok) return;
  try {
    const token = await resolveGitHubToken(freshPanel.webhook_owner_user_id);
    if (!token) return;
    const desired = !!freshPanel.webhook_enabled && !!freshPanel.domain;
    const secret = freshPanel.webhook_secret || crypto.randomUUID();
    const desiredUrl = `https://${freshPanel.domain}/webhooks/github/panel`;
    let providerRepo = freshPanel.github_webhook_repo || freshPanel.git_repo;
    let providerId = freshPanel.github_webhook_id;
    if (providerRepo !== freshPanel.git_repo) {
      await reconcileHook({
        gitRepo: providerRepo,
        desired: false,
        desiredId: providerId,
        desiredUrl,
        secret,
        token,
      });
      db.updatePanelWebhookProviderIdentity("", "");
      providerRepo = freshPanel.git_repo;
      providerId = "";
    }
    if (!providerRepo.includes("github.com")) {
      log("panel: webhook desired state requires a GitHub repository");
      return;
    }
    db.updatePanelWebhookProviderIdentity(providerRepo);
    const id = await reconcileHook({
      gitRepo: providerRepo,
      desired,
      desiredId: providerId,
      desiredUrl,
      secret,
      token,
    });
    db.updatePanelWebhookProviderIdentity(id ? providerRepo : "", id);
    if (!desired) {
      db.updatePanelWebhook(!!freshPanel.webhook_enabled, freshPanel.webhook_secret, id, freshPanel.webhook_owner_user_id);
      if (!freshPanel.webhook_enabled) db.finalizePanelWebhookDisabled();
    } else if (id !== freshPanel.github_webhook_id || secret !== freshPanel.webhook_secret) {
      db.updatePanelWebhook(true, secret, id, freshPanel.webhook_owner_user_id);
    }
  } catch (error) {
    log(`panel: ${error}`);
  } finally {
    release(keys);
  }
}
