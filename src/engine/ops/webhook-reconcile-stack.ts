import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  findActiveDeploymentOperationForCommit,
} from "../../shared/db/operations.ts";
import { compareCommitsWithRetry, getCommitCiStatus } from "../../shared/github.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import {
  evaluateWebhookPaths,
  parseStoredWebhookPaths,
  parseStoredWebhookPathsIgnore,
} from "../../shared/webhook-paths.ts";
import { stagingDeployRequest } from "../../server/lib/staging.ts";
import { isStackDestructionActiveForApp } from "../../server/lib/stack-operations.ts";
import { topoLevels } from "./deploy-stack.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import type { AppRow } from "../../shared/db/apps.ts";

const CI_POLL_INTERVAL = 15_000;
const CI_TIMEOUT = 30 * 60_000;

export type WebhookReconcileInput = {
  candidateId: number;
  repository?: string;
  branch?: string;
  beforeSha?: string;
  headSha?: string;
};

type EligibilityOut = {
  eligible: boolean;
  ciResult: string;
  reason?: string;
};

export type WebhookMemberDecision = {
  appId: number;
  appName: string;
  decision: "selected" | "skipped" | "no-op" | "reused";
  reason: string;
  base: string | null;
  head: string;
  changedPaths: string[];
  matchingPaths: string[];
  matchedPatterns: string[];
  operationId?: number;
  comparisonError?: string;
};

function candidateMembers(candidate: db.WebhookCandidateRow): AppRow[] {
  const members = candidate.stack_id == null
    ? [db.getApp(candidate.origin_app_id)].filter((app): app is AppRow => !!app)
    : db.getAppsByStackId(candidate.stack_id);
  return members.filter((app) => app.target_of == null);
}

function currentCandidate(candidateId: number): db.WebhookCandidateRow | null {
  const candidate = db.getWebhookCandidate(candidateId);
  return candidate && db.isWebhookCandidateCurrent(candidate) ? candidate : null;
}

function recordAll(
  candidate: db.WebhookCandidateRow,
  ciResult: string,
  decision: Omit<WebhookMemberDecision, "appId" | "appName" | "base" | "head" | "changedPaths" | "matchingPaths" | "matchedPatterns">,
): void {
  for (const app of candidateMembers(candidate)) {
    db.recordAppWebhookDecision(app.id, candidate.head_sha, ciResult, {
      app_id: app.id,
      app_name: app.name,
      base: db.getDeployedCommit(app.id),
      head: candidate.head_sha,
      changed_paths: [],
      matching_paths: [],
      matched_patterns: [],
      ...decision,
    });
  }
}

const resolveEligibility: Step<WebhookReconcileInput, EligibilityOut> = {
  name: "resolve_candidate_eligibility",
  label: "Wait for CI",
  async run(ctx) {
    const candidate = currentCandidate(ctx.input.candidateId);
    if (!candidate) return { eligible: false, ciResult: "superseded", reason: "newer push superseded candidate" };
    ctx.log(`Commit: ${candidate.head_sha}`);
    ctx.log(`Trigger: webhook (${candidate.repository}#${candidate.branch})`);
    const members = candidateMembers(candidate).filter((app) =>
      !!app.webhook_enabled && app.git_repo === candidate.repository &&
      (app.webhook_branch || "main") === candidate.branch
    );
    if (!members.some((app) => !!app.webhook_wait_for_ci)) {
      db.updateWebhookCandidate(candidate.id, { status: "eligible", ciResult: "not_required" });
      ctx.log("CI: not required");
      return { eligible: true, ciResult: "not_required" };
    }

    const tokenOwner = members.find((app) => app.deployed_by)?.deployed_by;
    const token = await resolveGitHubToken(tokenOwner || undefined);
    if (!token) {
      const reason = "GitHub token unavailable; configured CI could not be verified";
      db.updateWebhookCandidate(candidate.id, { status: "ignored", ciResult: "unavailable" });
      recordAll(candidate, "unavailable", { decision: "skipped", reason });
      return { eligible: false, ciResult: "unavailable", reason };
    }

    db.updateWebhookCandidate(candidate.id, { status: "waiting_for_ci", ciResult: "pending" });
    const deadline = Date.now() + CI_TIMEOUT;
    ctx.park();
    try {
      while (Date.now() < deadline) {
        if (ctx.isCancelRequested() || !currentCandidate(candidate.id)) {
          db.updateWebhookCandidate(candidate.id, { status: "superseded", ciResult: "superseded" });
          return { eligible: false, ciResult: "superseded", reason: "newer push superseded candidate" };
        }
        try {
          const status = await getCommitCiStatus({
            gitRepo: candidate.repository,
            ref: candidate.head_sha,
            token,
          });
          if (status === "success") {
            db.updateWebhookCandidate(candidate.id, { status: "eligible", ciResult: "success" });
            ctx.log("CI: success");
            return { eligible: true, ciResult: "success" };
          }
          if (status === "failure") {
            const reason = "CI failed or was cancelled";
            db.updateWebhookCandidate(candidate.id, { status: "ignored", ciResult: "failure" });
            ctx.log("CI: failure; candidate ignored");
            recordAll(candidate, "failure", { decision: "skipped", reason });
            return { eligible: false, ciResult: "failure", reason };
          }
        } catch (error) {
          ctx.log(`CI poll failed (will retry): ${error instanceof Error ? error.message : error}`);
        }
        await Bun.sleep(CI_POLL_INTERVAL);
      }
    } finally {
      ctx.unpark();
    }
    const reason = "CI checks timed out";
    db.updateWebhookCandidate(candidate.id, { status: "ignored", ciResult: "timeout" });
    recordAll(candidate, "timeout", { decision: "skipped", reason });
    return { eligible: false, ciResult: "timeout", reason };
  },
};

function stackKeys(app: AppRow): string[] {
  if (app.stack_id == null) return [];
  const stack = db.getStack(app.stack_id);
  return stack ? [`stack:${stack.id}`, `stack:${stack.name}`] : [];
}

function memberKey(app: AppRow, stackName: string | null): string {
  const prefix = stackName ? `${stackName}-` : "";
  return prefix && app.name.startsWith(prefix) ? app.name.slice(prefix.length) : app.name;
}

function targetAppForWebhook(app: AppRow): AppRow | null {
  return app.webhook_staging_environment_id != null ? db.getStagingSibling(app.id) : app;
}

function alreadyRunningCandidate(app: AppRow, head: string): boolean {
  const deployed = db.getLastSuccessfulDeployment(app.id);
  return app.status === "running" && !!deployed &&
    db.gitCommitsMatch(deployed.git_commit, head) &&
    deployed.config_revision === app.config_revision;
}

async function changedPathsForApp(
  app: AppRow,
  head: string,
  cache: Map<string, Promise<string[]>>,
): Promise<string[]> {
  const deployment = db.getLastSuccessfulDeployment(app.id);
  if (!deployment) return [];
  const base = deployment.git_commit;
  let pending = cache.get(base);
  if (!pending) {
    pending = (async () => {
      const token = await resolveGitHubToken(app.deployed_by || undefined);
      if (!token) throw new Error("GitHub token unavailable for compare");
      const files = await compareCommitsWithRetry({
        gitRepo: app.git_repo,
        base,
        head,
        token,
      });
      const paths = new Set<string>();
      for (const file of files) {
        paths.add(file.path);
        if (file.previousPath) paths.add(file.previousPath);
      }
      return [...paths].sort();
    })();
    cache.set(base, pending);
  }
  return pending;
}

export async function decideMember(
  app: AppRow,
  candidate: db.WebhookCandidateRow,
  cache: Map<string, Promise<string[]>>,
): Promise<WebhookMemberDecision> {
  const deployment = db.getLastSuccessfulDeployment(app.id);
  const base = deployment?.git_commit ?? null;
  const common = {
    appId: app.id,
    appName: app.name,
    base,
    head: candidate.head_sha,
    changedPaths: [] as string[],
    matchingPaths: [] as string[],
    matchedPatterns: [] as string[],
  };
  if (!app.webhook_enabled) {
    return { ...common, decision: "skipped", reason: "webhook disabled" };
  }
  if (app.git_repo !== candidate.repository || (app.webhook_branch || "main") !== candidate.branch) {
    return { ...common, decision: "skipped", reason: "repository or branch does not match candidate" };
  }

  const target = targetAppForWebhook(app);
  if (target && alreadyRunningCandidate(target, candidate.head_sha)) {
    return { ...common, decision: "no-op", reason: "candidate SHA and desired configuration already running" };
  }
  if (deployment && db.gitCommitsMatch(deployment.git_commit, candidate.head_sha)) {
    return {
      ...common,
      decision: "selected",
      reason: `candidate SHA is present but desired configuration revision r${app.config_revision} is not running`,
    };
  }
  if (!deployment) {
    return { ...common, decision: "selected", reason: "no successful deployment commit" };
  }

  let changedPaths: string[];
  try {
    changedPaths = await changedPathsForApp(app, candidate.head_sha, cache);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...common,
      decision: "selected",
      reason: "commit comparison failed; fail-open deployment",
      comparisonError: message,
    };
  }
  const pathDecision = evaluateWebhookPaths(
    changedPaths,
    {
      paths: parseStoredWebhookPaths(app.webhook_paths, app.webhook_path),
      pathsIgnore: parseStoredWebhookPathsIgnore(app.webhook_paths_ignore),
    },
    [app.manifest_path || app.last_manifest_path, app.stack_manifest_path],
  );
  return {
    ...common,
    decision: pathDecision.selected ? "selected" : "skipped",
    reason: pathDecision.reason,
    changedPaths,
    matchingPaths: pathDecision.matchingPaths,
    matchedPatterns: pathDecision.matchedPatterns,
  };
}

function persistDecision(app: AppRow, ciResult: string, decision: WebhookMemberDecision): void {
  db.recordAppWebhookDecision(app.id, decision.head, ciResult, {
    decision: decision.decision,
    reason: decision.reason,
    base: decision.base,
    head: decision.head,
    changed_paths: decision.changedPaths,
    matching_paths: decision.matchingPaths,
    matched_patterns: decision.matchedPatterns,
    operation_id: decision.operationId,
    comparison_error: decision.comparisonError,
  });
}

const evaluateMembers: Step<WebhookReconcileInput, { decisions: WebhookMemberDecision[] }> = {
  name: "evaluate_stack_members",
  label: "Evaluate stack members",
  async run(ctx, prior) {
    const eligibility = prior["resolve_candidate_eligibility"] as EligibilityOut;
    const stored = db.getWebhookCandidate(ctx.input.candidateId);
    if (!stored) throw new Error("Webhook candidate disappeared");
    if (!eligibility.eligible) return { decisions: [] };
    const candidate = currentCandidate(stored.id);
    if (!candidate) return { decisions: [] };
    db.updateWebhookCandidate(candidate.id, { status: "evaluating" });

    const members = candidateMembers(candidate);
    const compareCache = new Map<string, Promise<string[]>>();
    const decisions: WebhookMemberDecision[] = [];
    for (const app of members) {
      const decision = await decideMember(app, candidate, compareCache);
      decisions.push(decision);
      persistDecision(app, eligibility.ciResult, decision);
      ctx.log(`${app.name}: ${decision.decision} — ${decision.reason}`);
      if (app.stack_id != null) {
        db.appendStackLog(app.stack_id, `[webhook ${candidate.head_sha.slice(0, 12)}] ${app.name}: ${decision.decision} — ${decision.reason}`);
      }
    }

    return { decisions };
  },
};

const reconcileMembers: Step<WebhookReconcileInput, { decisions: WebhookMemberDecision[] }> = {
  name: "reconcile_stack_members",
  label: "Deploy selected stack members",
  async run(ctx, prior) {
    const eligibility = prior["resolve_candidate_eligibility"] as EligibilityOut;
    const evaluated = prior["evaluate_stack_members"] as { decisions: WebhookMemberDecision[] };
    if (!eligibility.eligible) return evaluated;
    const stored = db.getWebhookCandidate(ctx.input.candidateId);
    if (!stored) throw new Error("Webhook candidate disappeared");
    const candidate = currentCandidate(stored.id);
    if (!candidate) return evaluated;
    const members = candidateMembers(candidate);
    const decisions = evaluated.decisions;

    const selected = members.filter((app) =>
      decisions.find((decision) => decision.appId === app.id)?.decision === "selected"
    );
    const stack = candidate.stack_id == null ? null : db.getStack(candidate.stack_id);
    const byKey = new Map(members.map((app) => [memberKey(app, stack?.name ?? null), app]));
    const selectedNodes = selected.map((app) => ({
      key: memberKey(app, stack?.name ?? null),
      needs: db.parseStackNeeds(app.stack_needs),
    }));
    const levels = topoLevels(selectedNodes);

    for (const level of levels) {
      if (!currentCandidate(candidate.id)) break;
      const childIds: number[] = [];
      for (const key of level) {
        const app = byKey.get(key)!;
        if (isStackDestructionActiveForApp(app.id)) {
          throw new Error(`Stack destruction started before ${app.name} could deploy`);
        }
        // needs gates order/readiness only. It never expands the selected set.
        for (const dependencyKey of db.parseStackNeeds(app.stack_needs)) {
          const dependency = byKey.get(dependencyKey);
          if (dependency && !selected.includes(dependency) && dependency.status !== "running") {
            throw new Error(`${app.name} requires ${dependency.name}, which is not ready`);
          }
        }

        let target = targetAppForWebhook(app);
        const active = target
          ? findActiveDeploymentOperationForCommit(target.id, candidate.head_sha)
          : null;
        const decision = decisions.find((item) => item.appId === app.id)!;
        if (active) {
          decision.decision = "reused";
          decision.reason = `reused pending/running operation #${active.id}`;
          decision.operationId = active.id;
          persistDecision(app, eligibility.ciResult, decision);
          ctx.log(`${app.name}: reused operation #${active.id}`);
          continue;
        }

        const idempotencyKey = `webhook-app:${app.id}:${candidate.head_sha}:r${app.config_revision}`;
        let child;
        if (app.webhook_staging_environment_id != null) {
          if (target) {
            // Reconcile the staging environment as part of the redeploy
            // candidate. The redeploy saga validates the candidate, starts and
            // verifies it, then commits desired configuration. Mutating the app
            // row here before enqueue would leave a failed child pointing at an
            // environment it never successfully ran with.
            const candidateRequest = stagingDeployRequest(app, candidate.head_sha);
            child = enqueueOperation({
              kind: "redeploy",
              resourceKeys: [`app:${target.id}`, ...stackKeys(app)],
              input: {
                appId: target.id,
                userId: app.deployed_by || undefined,
                gitSha: candidate.head_sha,
                candidate: candidateRequest,
              },
              trigger: "webhook",
              triggeredBy: `github:${candidate.delivery_id}`,
              parentId: ctx.opId,
              idempotencyKey,
            });
          } else {
            const req = stagingDeployRequest(app, candidate.head_sha);
            child = enqueueOperation({
              kind: "deploy",
              resourceKeys: [`app:create:${req.app_name}`, ...stackKeys(app)],
              input: req,
              trigger: "webhook",
              triggeredBy: `github:${candidate.delivery_id}`,
              parentId: ctx.opId,
              idempotencyKey,
            });
          }
        } else {
          child = enqueueOperation({
            kind: "redeploy",
            resourceKeys: [`app:${app.id}`, ...stackKeys(app)],
            input: { appId: app.id, userId: app.deployed_by || undefined, gitSha: candidate.head_sha },
            trigger: "webhook",
            triggeredBy: `github:${candidate.delivery_id}`,
            parentId: ctx.opId,
            idempotencyKey,
          });
        }
        childIds.push(child.id);
        decision.operationId = child.id;
        persistDecision(app, eligibility.ciResult, decision);
      }
      if (childIds.length > 0) await awaitChildren(ctx, { childIds });
    }

    return { decisions };
  },
};

const finalizeCandidate: Step<WebhookReconcileInput, { done: boolean }> = {
  name: "finalize_candidate",
  label: "Finalize webhook candidate",
  async probe(ctx) {
    const candidate = db.getWebhookCandidate(ctx.input.candidateId);
    return candidate?.status === "done" ? { done: true } : null;
  },
  async run(ctx, prior) {
    const eligibility = prior["resolve_candidate_eligibility"] as EligibilityOut;
    const candidate = currentCandidate(ctx.input.candidateId);
    if (!eligibility.eligible || !candidate) return { done: false };
    db.updateWebhookCandidate(candidate.id, { status: "done" });
    return { done: true };
  },
};

const webhookReconcileStackOp: OpKindDefinition<WebhookReconcileInput> = {
  kind: "webhook_reconcile_stack",
  label: "Webhook reconcile stack",
  resourceKeys: (input) => [`webhook-candidate:${input.candidateId}`],
  steps: [resolveEligibility, evaluateMembers, reconcileMembers, finalizeCandidate],
};

registerOp(webhookReconcileStackOp as OpKindDefinition<any>);
export default webhookReconcileStackOp;
