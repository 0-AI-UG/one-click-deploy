import { beforeEach, describe, expect, test } from "bun:test";
import { randomSuffix, useTempDataDir } from "../test-helpers.ts";

useTempDataDir();

import * as db from "../db.ts";

function makeApp() {
  return db.insertApp({
    name: `intent-${randomSuffix()}`,
    domain: "old.example.com",
    image_ref: `ghcr.io/acme/test@sha256:${"a".repeat(64)}`,
    container_port: 3000,
    env_vars: "{}",
  });
}

describe("durable reconciler intents", () => {
  beforeEach(() => db.deletePanel());

  test("rollout intent follows every config revision created by an apply", () => {
    const app = makeApp();
    db.requestAppRollout(app.id, app.config_revision);

    db.updateAppDomain(app.id, "new.example.com");
    db.updateAppContainerPort(app.id, 4000);

    const fresh = db.getApp(app.id)!;
    expect(fresh.config_revision).toBe(app.config_revision + 2);
    expect(fresh.rollout_requested_revision).toBe(fresh.config_revision);
  });

  test("same-revision rollout intent records the deployment it must supersede", () => {
    const app = makeApp();
    const deployed = db.insertDeployment({
      app_id: app.id,
      image_tag: `${app.name}:latest`,
      image_digest: "sha256:old",
      git_commit: "old",
      config_revision: app.config_revision,
    });

    db.requestAppRollout(app.id, app.config_revision);
    let fresh = db.getApp(app.id)!;
    expect(fresh.rollout_requested_after_deployment_id).toBe(deployed.id);

    db.clearAppRolloutRequest(app.id, app.config_revision);
    fresh = db.getApp(app.id)!;
    expect(fresh.rollout_requested_revision).toBe(0);
    expect(fresh.rollout_requested_after_deployment_id).toBe(0);
  });

  test("deploy=false config changes do not invent rollout intent", () => {
    const app = makeApp();
    db.updateAppDomain(app.id, "saved-only.example.com");

    expect(db.getApp(app.id)?.rollout_requested_revision).toBe(0);
  });

  test("service deletion intent is durable and idempotent", () => {
    const service = db.insertService({
      name: `service-${randomSuffix()}`,
      service_type: "postgres",
      version: "16",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    db.markServiceDeletionRequested(service.id);
    const first = db.getService(service.id)?.deletion_requested_at;
    db.markServiceDeletionRequested(service.id);
    expect(first).toBeTruthy();
    expect(db.getService(service.id)?.deletion_requested_at).toBe(first);
  });
});
