import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireCliPermission, stackScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { redeployPanel } from "../../engine/deploy/panel.ts";
import { isStackDestructionActiveForApp } from "../lib/stack-operations.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { timingSafeEqual } from "node:crypto";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { compareCommitsWithRetry } from "../../shared/github.ts";
import {
  evaluateWebhookPaths,
  parseStoredWebhookPaths,
  parseStoredWebhookPathsIgnore,
} from "../../shared/webhook-paths.ts";

// Normalize a user-supplied repo path filter: strip leading/trailing slashes
// and surrounding whitespace. Empty string means "no filter".
export function normalizeWebhookPath(p: string): string {
  return p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

// Returns true if any file mentioned in the push payload's commits sits under
// `prefix`. An empty prefix matches everything.
interface GitHubPushPayload {
  ref?: string;
  before?: string;
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
// Verifies HMAC-SHA256 against one member's stored secret, persists one
// repository+branch+head candidate, and enqueues one stack-wide evaluation.
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

    const fullSha = payload.after ? String(payload.after) : "";
    if (!/^[a-f0-9]{7,40}$/i.test(fullSha) || /^0+$/.test(fullSha)) {
      return new Response("Push has no deployable head commit", { status: 204 });
    }
    const deliveryId = request.headers.get("x-github-delivery") || `${appId}:${fullSha}:${Date.now()}`;
    const { candidate } = db.createWebhookCandidate({
      repository: app.git_repo,
      branch: app.webhook_branch || "main",
      beforeSha: payload.before ? String(payload.before) : "",
      headSha: fullSha,
      originAppId: app.id,
      stackId: app.stack_id,
      deliveryId,
    });
    const members = app.stack_id == null ? [app] : db.getAppsByStackId(app.stack_id);
    for (const member of members) db.recordAppWebhookReceived(member.id, fullSha);

    const { opId } = enqueue({
      kind: "webhook_reconcile_stack",
      resourceKeys: [
        `webhook-candidate:${candidate.id}`,
        ...(candidate.stack_id == null ? [] : [`stack-webhook:${candidate.stack_id}`]),
      ],
      input: {
        candidateId: candidate.id,
        repository: candidate.repository,
        branch: candidate.branch,
        beforeSha: candidate.before_sha,
        headSha: candidate.head_sha,
      },
      trigger: "webhook",
      triggeredBy: `github:${deliveryId}`,
      idempotencyKey: `webhook-candidate:${candidate.repository}:${candidate.branch}:${candidate.head_sha}`,
    });
    if (candidate.parent_operation_id == null) db.setWebhookCandidateOperation(candidate.id, opId);
    return new Response(`Accepted operation #${opId}`, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}

/** Read-only diagnostic using an explicit common base/head for every member. */
export async function handleWebhookPlan(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const stackName = url.searchParams.get("stack") || "";
    const base = url.searchParams.get("base") || "";
    const head = url.searchParams.get("head") || "";
    if (!stackName || !/^[a-f0-9]{7,40}$/i.test(base) || !/^[a-f0-9]{7,40}$/i.test(head)) {
      return Response.json(
        { error: "stack, base, and head (Git SHAs) are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const stack = db.getStackByName(stackName);
    if (!stack) return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    const auth = await requireCliPermission(request, "stacks.view", stackScope(stack.id));
    const apps = db.getAppsByStackId(stack.id).filter((app) => app.target_of == null);
    const repository = apps.find((app) => app.webhook_enabled)?.git_repo || apps[0]?.git_repo;
    if (!repository) return Response.json({ error: "Stack has no app repository" }, { status: 400, headers: corsHeaders });
    const token = await resolveGitHubToken(auth.userId);
    let changedPaths: string[] = [];
    let comparisonError: string | null = null;
    try {
      if (!token) throw new Error("GitHub token unavailable for compare");
      const files = await compareCommitsWithRetry({ gitRepo: repository, base, head, token });
      const paths = new Set<string>();
      for (const file of files) {
        paths.add(file.path);
        if (file.previousPath) paths.add(file.previousPath);
      }
      changedPaths = [...paths].sort();
    } catch (error) {
      comparisonError = error instanceof Error ? error.message : String(error);
    }
    const decisions = apps.map((app) => {
      if (!app.webhook_enabled) return { app: app.name, action: "skip", reason: "webhook disabled", matching_paths: [] };
      if (app.git_repo !== repository) return { app: app.name, action: "skip", reason: "different repository", matching_paths: [] };
      if (comparisonError) return {
        app: app.name,
        action: "deploy",
        reason: "commit comparison failed; fail-open deployment",
        matching_paths: [],
      };
      const decision = evaluateWebhookPaths(
        changedPaths,
        {
          paths: parseStoredWebhookPaths(app.webhook_paths, app.webhook_path),
          pathsIgnore: parseStoredWebhookPathsIgnore(app.webhook_paths_ignore),
        },
        [app.manifest_path || app.last_manifest_path, app.stack_manifest_path],
      );
      return {
        app: app.name,
        action: decision.selected ? "deploy" : "skip",
        reason: decision.reason,
        matching_paths: decision.matchingPaths,
        matched_patterns: decision.matchedPatterns,
      };
    });
    return Response.json({
      stack: stack.name,
      repository,
      base,
      head,
      changed_paths: changedPaths,
      comparison_error: comparisonError,
      decisions,
    }, { headers: corsHeaders });
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
    const webhookSecret = panel.webhook_secret || crypto.randomUUID();
    db.updatePanelWebhook(true, webhookSecret, panel.github_webhook_id, payload.userId);

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

    // Preserve provider id/owner until the reconciler confirms remote absence.
    db.updatePanelWebhook(false, panel.webhook_secret, panel.github_webhook_id, payload.userId);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
