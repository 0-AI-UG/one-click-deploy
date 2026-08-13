import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import { enqueueOperation, getOperation } from "./operations.ts";

function appFor(repo: string) {
  return db.insertApp({
    name: `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    domain: "",
    git_repo: repo,
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

describe("webhook candidates", () => {
  test("repository + branch + head is idempotent", () => {
    const repo = `https://github.com/acme/idempotent-${Date.now()}`;
    const app = appFor(repo);
    const input = {
      repository: repo,
      branch: "main",
      beforeSha: "a".repeat(40),
      headSha: "b".repeat(40),
      originAppId: app.id,
      stackId: null,
      deliveryId: "delivery-1",
    };
    const first = db.createWebhookCandidate(input);
    const duplicate = db.createWebhookCandidate({ ...input, deliveryId: "delivery-2" });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.candidate.id).toBe(first.candidate.id);
  });

  test("a newer push supersedes and cancels an older pending evaluation", () => {
    const repo = `https://github.com/acme/supersede-${Date.now()}`;
    const app = appFor(repo);
    const first = db.createWebhookCandidate({
      repository: repo,
      branch: "main",
      beforeSha: "1".repeat(40),
      headSha: "2".repeat(40),
      originAppId: app.id,
      stackId: null,
      deliveryId: "delivery-old",
    }).candidate;
    const operation = enqueueOperation({
      kind: "webhook_reconcile_stack",
      resourceKeys: [`webhook-candidate:${first.id}`],
      input: { candidateId: first.id },
      trigger: "webhook",
    });
    db.setWebhookCandidateOperation(first.id, operation.id);
    const second = db.createWebhookCandidate({
      repository: repo,
      branch: "main",
      beforeSha: first.head_sha,
      headSha: "3".repeat(40),
      originAppId: app.id,
      stackId: null,
      deliveryId: "delivery-new",
    }).candidate;
    expect(db.getWebhookCandidate(first.id)).toMatchObject({
      status: "superseded",
      superseded_by_head: second.head_sha,
    });
    expect(getOperation(operation.id)?.status).toBe("cancelled");
  });

  test("an out-of-order parent delivery cannot supersede its already-seen child", () => {
    const repo = `https://github.com/acme/out-of-order-${Date.now()}`;
    const app = appFor(repo);
    const parentHead = "4".repeat(40);
    const childHead = "5".repeat(40);
    const child = db.createWebhookCandidate({
      repository: repo,
      branch: "main",
      beforeSha: parentHead,
      headSha: childHead,
      originAppId: app.id,
      stackId: null,
      deliveryId: "delivery-child",
    }).candidate;
    const delayedParent = db.createWebhookCandidate({
      repository: repo,
      branch: "main",
      beforeSha: "3".repeat(40),
      headSha: parentHead,
      originAppId: app.id,
      stackId: null,
      deliveryId: "delivery-parent-delayed",
    }).candidate;
    expect(delayedParent).toMatchObject({ status: "superseded", superseded_by_head: childHead });
    expect(db.isWebhookCandidateCurrent(delayedParent)).toBe(false);
    expect(db.isWebhookCandidateCurrent(child)).toBe(true);
  });
});
