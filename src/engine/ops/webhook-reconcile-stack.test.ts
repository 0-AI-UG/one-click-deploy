import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import { decideMember } from "./webhook-reconcile-stack.ts";

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
