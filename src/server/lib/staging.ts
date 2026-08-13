import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";
import type { DeployRequest } from "../../shared/rpc.ts";
import { stackLockKeys } from "./stack-operations.ts";

/** The deploy-target tag of the auto-managed staging sibling. */
export const STAGING_TARGET = "staging";

/** Build a DeployRequest that clones a production app's build + routing config
 *  for its `<name>-staging` sibling. The sibling links to the environment the
 *  user selected for staging (prod.webhook_staging_environment_id) — no live
 *  inheritance from production. Volumes/webhooks are NOT carried over: staging
 *  is a clean, isolated deploy. */
export function stagingDeployRequest(prod: db.AppRow, gitSha?: string): DeployRequest {
  return {
    environment_id: prod.webhook_staging_environment_id ?? undefined,
    app_name: `${prod.name}-${STAGING_TARGET}`,
    git_repo: prod.git_repo,
    // Track the branch the webhook watches (what was just pushed) so staging
    // reflects the incoming commit; fall back to prod's deploy branch.
    git_branch: prod.webhook_branch || prod.git_branch || undefined,
    git_sha: gitSha,
    container_port: prod.container_port,
    dockerfile_path: prod.dockerfile_path || undefined,
    docker_context: prod.docker_context || undefined,
    public: prod.public === 1,
    health_check: prod.health_check === 0 ? false : undefined,
    internal_protocol: prod.internal_protocol === "tcp" ? "tcp" : "http",
    sticky: prod.sticky === 1 || undefined,
    rate_limit_rps: prod.rate_limit_rps || undefined,
    ip_allowlist: prod.ip_allowlist || undefined,
    health_check_path: prod.health_check_path || undefined,
    compress: prod.compress === 1 || undefined,
    memory_mb: prod.memory_mb || undefined,
    cpu_limit: prod.cpu_limit || undefined,
    durability_class: (prod.durability_class as DeployRequest["durability_class"]) || undefined,
    target: STAGING_TARGET,
    target_of: prod.id,
    placement_pool: STAGING_TARGET,
  };
}

export type DeployToStagingResult =
  | { ok: true; opId: number; siblingName: string; created: boolean }
  | { ok: false; error: string };

/**
 * Deploy a production app's latest pushed commit to its staging sibling, holding
 * production untouched. On the first call the `<name>-staging` sibling doesn't
 * exist yet, so this enqueues a `deploy` op to create it; afterwards it enqueues
 * a `redeploy` on the existing sibling. Either way the sibling rebuilds from its
 * branch HEAD, so it lands on the just-pushed commit.
 *
 * Used by the webhook staging flow. `trigger`/`triggeredBy`/`idempotencyKey`
 * are threaded to the op so retries of the same GitHub delivery collapse.
 */
export function deployToStaging(
  prodAppId: number,
  opts: { userId?: string; trigger?: string; triggeredBy?: string; idempotencyKey?: string; gitSha?: string } = {},
): DeployToStagingResult {
  const prod = db.getApp(prodAppId);
  if (!prod) return { ok: false, error: "App not found" };
  // A sibling can't own further siblings — staging hangs off a production app.
  if (prod.target !== "" && prod.target !== "production") {
    return { ok: false, error: `"${prod.name}" is itself a ${prod.target} target` };
  }
  if (prod.webhook_staging_environment_id == null) {
    return { ok: false, error: `No staging environment selected for "${prod.name}"` };
  }

  const existing = db.getStagingSibling(prodAppId);
  const trigger = opts.trigger ?? "webhook";
  const stack = prod.stack_id == null ? null : db.getStack(prod.stack_id);
  const stackKeys = stack ? stackLockKeys(stack) : [];

  if (existing) {
    // Keep the sibling pointed at the currently-selected staging environment —
    // the user may have changed it since the sibling was first deployed.
    if (existing.environment_id !== prod.webhook_staging_environment_id) {
      db.updateAppEnvironment(existing.id, prod.webhook_staging_environment_id);
    }
    const { opId } = enqueue({
      kind: "redeploy",
      resourceKeys: [`app:${existing.id}`, ...stackKeys],
      input: { appId: existing.id, userId: opts.userId, gitSha: opts.gitSha },
      trigger,
      triggeredBy: opts.triggeredBy,
      idempotencyKey: opts.idempotencyKey,
    });
    return { ok: true, opId, siblingName: existing.name, created: false };
  }

  const req = stagingDeployRequest(prod, opts.gitSha);
  const { opId } = enqueue({
    kind: "deploy",
    resourceKeys: [`app:create:${req.app_name}`, ...stackKeys],
    input: req,
    trigger,
    triggeredBy: opts.triggeredBy ?? opts.userId,
    idempotencyKey: opts.idempotencyKey,
  });
  return { ok: true, opId, siblingName: req.app_name, created: true };
}
