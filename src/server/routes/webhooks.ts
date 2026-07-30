import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import * as github from "../../shared/github.ts";
import { redeployPanel } from "../../engine/deploy/panel.ts";
import { isStackDestructionActiveForApp } from "../lib/stack-operations.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { deployToStaging } from "../lib/staging.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { getCommitCiStatus } from "../../shared/github.ts";
import { timingSafeEqual } from "node:crypto";

const CI_POLL_INTERVAL = 15_000;
const CI_TIMEOUT = 30 * 60_000;

async function waitForCi(appId: number, sha: string): Promise<boolean> {
  const app = db.getApp(appId);
  if (!app) return false;
  const token = await resolveGitHubToken(app.deployed_by || undefined);
  if (!token) return true; // can't check, proceed
  const deadline = Date.now() + CI_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const status = await getCommitCiStatus({ gitRepo: app.git_repo, ref: sha, token });
      if (status === "success") return true;
      if (status === "failure") {
        db.insertDeployment({
          app_id: appId,
          image_tag: `${app.name}:latest`,
          git_commit: sha.slice(0, 7),
          status: "failed",
          source: "webhook",
          config_revision: app.config_revision ?? 1,
          deploy_log: `CI checks failed for commit ${sha.slice(0, 7)}; deploy skipped`,
        });
        return false;
      }
    } catch (err) {
      console.error(`[webhook] CI poll error for app ${appId}:`, err);
    }
    await Bun.sleep(CI_POLL_INTERVAL);
  }
  db.insertDeployment({
    app_id: appId,
    image_tag: `${app.name}:latest`,
    git_commit: sha.slice(0, 7),
    status: "failed",
    source: "webhook",
    config_revision: app.config_revision ?? 1,
    deploy_log: `CI checks timed out after 30 minutes for commit ${sha.slice(0, 7)}; deploy skipped`,
  });
  return false;
}

// Normalize a user-supplied repo path filter: strip leading/trailing slashes
// and surrounding whitespace. Empty string means "no filter".
export function normalizeWebhookPath(p: string): string {
  return p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

// Returns true if any file mentioned in the push payload's commits sits under
// `prefix`. An empty prefix matches everything.
interface GitHubPushPayload {
  ref?: string;
  after?: string;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

export function pushTouchesPath(payload: GitHubPushPayload, prefix: string): boolean {
  if (!prefix) return true;
  const needle = prefix + "/";
  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  for (const c of commits) {
    for (const list of [c?.added, c?.modified, c?.removed]) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (typeof f !== "string") continue;
        if (f === prefix || f.startsWith(needle)) return true;
      }
    }
  }
  return false;
}

// Verify GitHub HMAC-SHA256 signature against a secret using constant-time
// compare. Returns true iff the X-Hub-Signature-256 header matches.
export async function verifyGithubSignature(
  rawBody: string,
  secret: string,
  sigHeader: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const a = Buffer.from(expected);
  const b = Buffer.from(sigHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── GitHub push webhook receiver ──
//
// Verifies HMAC-SHA256 against the app's stored secret, checks the branch,
// and enqueues a rolling redeploy. Returns 202 immediately so GitHub does
// not time out (the redeploy runs in the background).
export async function handleGithubWebhook(request: Request, appId: number): Promise<Response> {
  try {
    const app = db.getApp(appId);
    if (!app || !app.webhook_enabled || !app.webhook_secret) {
      return new Response("Not found", { status: 404 });
    }
    if (isStackDestructionActiveForApp(appId)) {
      return new Response("Stack destruction in progress; webhook deployment dropped", { status: 202 });
    }

    const sigHeader = request.headers.get("x-hub-signature-256") || "";
    const rawBody = await request.text();

    if (!(await verifyGithubSignature(rawBody, app.webhook_secret, sigHeader))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: GitHubPushPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubPushPayload;
    } catch {
      return new Response("Bad payload", { status: 400 });
    }

    const expectedRef = `refs/heads/${app.webhook_branch || "main"}`;
    if (payload.ref !== expectedRef) {
      return new Response("Branch mismatch", { status: 204 });
    }

    const pathFilter = app.webhook_path || "";
    if (!pushTouchesPath(payload, pathFilter)) {
      return new Response("Path filter: no matching files", { status: 204 });
    }

    const fullSha = payload.after ? String(payload.after) : "";
    const deliveryId = request.headers.get("x-github-delivery") || `${appId}:${fullSha}:${Date.now()}`;
    // Delivery GUIDs differ when GitHub emits another event around CI
    // completion. Commit identity does not: app + full SHA is the deployment
    // unit operators care about, so both deliveries collapse onto one op.
    const dedupeId = fullSha || `delivery:${deliveryId}`;

    // CI-wait remains a panel-side prelude so we don't hold an engine slot
    // for 30 minutes. Once CI passes (or is disabled), enqueue the redeploy
    // op with a commit-scoped idempotency key so push/CI deliveries collapse.
    (async () => {
      try {
        if (app.webhook_wait_for_ci && fullSha) {
          const ok = await waitForCi(appId, fullSha);
          if (!ok) return;
        }
        // Destruction may have started during a long CI wait. Re-read durable
        // state before enqueueing so a deleted member cannot be resurrected.
        if (!db.getApp(appId) || isStackDestructionActiveForApp(appId)) {
          console.log(`[webhook] dropping deployment for app ${appId}: stack destruction is active or app is gone`);
          return;
        }
        // GitHub uses one delivery GUID per push across all webhooks on a repo.
        // Without app scoping, sibling apps sharing a repo collide on this key
        // and all but one get dropped.
        if (app.webhook_staging_environment_id != null) {
          // Staging mode: deploy the pushed commit to the <name>-staging sibling
          // and HOLD. Production keeps serving until the user clicks Promote.
          const res = deployToStaging(appId, {
            userId: app.deployed_by || undefined,
            trigger: "webhook",
            triggeredBy: `github:${deliveryId}`,
            idempotencyKey: `webhook-commit:staging:${appId}:${dedupeId}`,
            gitSha: fullSha || undefined,
          });
          if (!res.ok) console.error(`[webhook] staging deploy failed for app ${appId}: ${res.error}`);
        } else {
          enqueue({
            kind: "redeploy",
            resourceKeys: [`app:${appId}`],
            input: { appId, userId: app.deployed_by || undefined, gitSha: fullSha || undefined },
            trigger: "webhook",
            triggeredBy: `github:${deliveryId}`,
            idempotencyKey: `webhook-commit:${appId}:${dedupeId}`,
          });
        }
      } catch (err) {
        console.error(`[webhook] enqueue failed for app ${appId}:`, err);
      }
    })();

    return new Response("Accepted", { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}

// ── Panel self-update webhook ──
//
// Same HMAC + branch-check pattern as the per-app handler, but the redeploy
// kills our own container, so dispatch it as a detached background task and
// return 202 *before* the rebuild can possibly start tearing things down.
export async function handlePanelGithubWebhook(request: Request): Promise<Response> {
  try {
    const panel = db.getPanel();
    if (!panel || !panel.webhook_enabled || !panel.webhook_secret) {
      return new Response("Not found", { status: 404 });
    }

    const sigHeader = request.headers.get("x-hub-signature-256") || "";
    const rawBody = await request.text();

    if (!(await verifyGithubSignature(rawBody, panel.webhook_secret, sigHeader))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: GitHubPushPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubPushPayload;
    } catch {
      return new Response("Bad payload", { status: 400 });
    }

    const expectedRef = `refs/heads/${panel.git_branch || "main"}`;
    if (payload.ref !== expectedRef) {
      return new Response("Branch mismatch", { status: 204 });
    }

    const fullSha = (payload.after && String(payload.after)) || "";
    const sha = fullSha ? fullSha.slice(0, 7) : "unknown";

    // Detached: redeployPanel writes its DB state synchronously then dispatches
    // the rebuild via systemd-run, which will kill *this* container shortly
    // after. We must not await it — return 202 immediately.
    // Pass the FULL sha so redeployPanel can pull the immutable per-commit
    // GHCR tag (`sha-<fullSha>`) built from exactly this commit.
    redeployPanel(() => {}, { source: "webhook", gitCommit: sha, gitSha: fullSha }).catch((err) => {
      console.error(`[panel-webhook] redeploy failed:`, err);
    });

    return new Response("Accepted", { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleEnablePanelWebhook(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "panel.manage");

    const panel = db.getPanel();
    if (!panel) {
      return Response.json({ ok: false, error: "Panel is not configured" }, { headers: corsHeaders });
    }
    if (!panel.domain) {
      return Response.json(
        { ok: false, error: "Panel domain is not set. Set the panel's public domain before enabling the webhook." },
        { status: 400, headers: corsHeaders },
      );
    }

    const pat = await github.getGitHubPat(payload.userId);
    if (!pat) {
      return Response.json(
        { ok: false, error: "No GitHub token available. Link your GitHub account first." },
        { headers: corsHeaders },
      );
    }

    const webhookSecret = crypto.randomUUID();
    const url = `https://${panel.domain}/webhooks/github/panel`;
    const created = await github.createWebhookAtUrl({
      gitRepo: panel.git_repo,
      url,
      webhookSecret,
      token: pat,
    });

    db.updatePanelWebhook(true, webhookSecret, String(created.id));

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDisablePanelWebhook(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "panel.manage");

    const panel = db.getPanel();
    if (!panel) {
      return Response.json({ ok: false, error: "Panel is not configured" }, { headers: corsHeaders });
    }

    if (panel.github_webhook_id) {
      const pat = await github.getGitHubPat(payload.userId);
      if (pat) {
        try {
          await github.deleteWebhook({
            gitRepo: panel.git_repo,
            webhookId: panel.github_webhook_id,
            token: pat,
          });
        } catch (e) {
          console.error("webhooks: failed to delete GitHub webhook for panel:", e);
        }
      }
    }

    db.updatePanelWebhook(false, "", "");

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
