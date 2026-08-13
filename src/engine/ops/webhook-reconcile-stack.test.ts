import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  markOperationFinished,
} from "../../shared/db/operations.ts";
import type { OpContext } from "../types.ts";
import webhookReconcileStackOp, { decideMember } from "./webhook-reconcile-stack.ts";

function webhookApp() {
  const app = db.insertApp({
    name: `baseline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    domain: "",
    git_repo: `https://github.com/acme/baseline-${Date.now()}-${Math.random()}`,
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
  db.updateAppWebhook(app.id, true, "secret", "main", "hook");
  db.updateAppWebhookPaths(app.id, ["services/web/**"], []);
  return db.getApp(app.id)!;
}

function candidateFor(app: db.AppRow, head = "b".repeat(40)) {
  return db.createWebhookCandidate({
    repository: app.git_repo,
    branch: "main",
    beforeSha: "a".repeat(40),
    headSha: head,
    originAppId: app.id,
    stackId: null,
    deliveryId: crypto.randomUUID(),
  }).candidate;
}

describe("webhook member baseline decisions", () => {
  test("an app without a successful deployment always deploys", async () => {
    const app = webhookApp();
    const decision = await decideMember(app, candidateFor(app), new Map());
    expect(decision).toMatchObject({ decision: "selected", reason: "no successful deployment commit" });
  });

  test("a manual deployment that already reached SHA and config becomes a no-op", async () => {
    let app = webhookApp();
    const head = "c".repeat(40);
    db.updateAppStatus(app.id, "running");
    db.insertDeployment({
      app_id: app.id,
      image_tag: `${app.name}:latest`,
      git_commit: head.slice(0, 12),
      config_revision: app.config_revision,
    });
    app = db.getApp(app.id)!;
    const decision = await decideMember(app, candidateFor(app, head), new Map());
    expect(decision).toMatchObject({ decision: "no-op" });
  });

  test("an unavailable comparison fails open from the last deployed baseline", async () => {
    let app = webhookApp();
    db.insertDeployment({
      app_id: app.id,
      image_tag: `${app.name}:latest`,
      git_commit: "d".repeat(12),
      config_revision: app.config_revision,
    });
    app = db.getApp(app.id)!;
    const decision = await decideMember(app, candidateFor(app, "e".repeat(40)), new Map());
    expect(decision).toMatchObject({
      decision: "selected",
      reason: "commit comparison failed; fail-open deployment",
    });
  });
});

describe("webhook staging reconciliation boundary", () => {
  test("passes the staging environment as a redeploy candidate without mutating the sibling first", async () => {
    const productionEnv = db.insertEnvironment(`prod-${crypto.randomUUID()}`, "");
    const stagingEnv = db.insertEnvironment(`stage-${crypto.randomUUID()}`, "");
    const prod = webhookApp();
    db.updateAppEnvironment(prod.id, productionEnv.id);
    db.updateAppWebhookStagingEnvironment(prod.id, stagingEnv.id);
    const sibling = db.insertApp({
      name: `${prod.name}-staging`,
      domain: "",
      git_repo: prod.git_repo,
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
      environment_id: productionEnv.id,
    });
    db.setAppTarget(sibling.id, prod.id, "staging");
    const freshProd = db.getApp(prod.id)!;
    const candidate = candidateFor(freshProd, "f".repeat(40));
    const parent = enqueueOperation({
      kind: "webhook_reconcile_stack",
      resourceKeys: [`webhook-candidate:${candidate.id}`],
      input: { candidateId: candidate.id },
      trigger: "test",
    });
    const input = { candidateId: candidate.id };
    const ctx = {
      opId: parent.id,
      kind: parent.kind,
      input,
      trigger: "test",
      triggeredBy: "tester",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: () => {},
      park: () => {},
      unpark: () => {},
    } satisfies OpContext<typeof input>;
    const reconcile = webhookReconcileStackOp.steps.find(
      (step) => step.name === "reconcile_stack_members",
    )!;
    const decision = {
      appId: freshProd.id,
      appName: freshProd.name,
      decision: "selected" as const,
      reason: "test",
      base: null,
      head: candidate.head_sha,
      changedPaths: [],
      matchingPaths: [],
      matchedPatterns: [],
    };
    const poll = setInterval(() => {
      for (const child of listChildOperations(parent.id)) markOperationFinished(child.id, "done");
    }, 20);
    try {
      await reconcile.run(ctx, {
        resolve_candidate_eligibility: { eligible: true, ciResult: "not_required" },
        evaluate_stack_members: { decisions: [decision] },
      });
    } finally {
      clearInterval(poll);
    }

    expect(db.getApp(sibling.id)!.environment_id).toBe(productionEnv.id);
    const child = listChildOperations(parent.id)[0];
    expect(child.kind).toBe("redeploy");
    const childInput = JSON.parse(child.input_json);
    expect(childInput.candidate.environment_id).toBe(stagingEnv.id);
    expect(childInput.appId).toBe(sibling.id);
  });
});
