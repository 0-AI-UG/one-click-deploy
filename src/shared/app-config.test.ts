import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "./db.ts";
import { applyAppConfig, diffAppConfig } from "./app-config.ts";
import { serializeEnvVars } from "./env-crypto.ts";

function seedApp() {
  const suffix = randomSuffix();
  const env = db.insertEnvironment(`env-${suffix}`, serializeEnvVars([]));
  const app = db.insertApp({
    name: `app-${suffix}`,
    domain: `${suffix}.example.com`,
    git_repo: "https://github.com/acme/old",
    git_branch: "main",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    environment_id: env.id,
  });
  return { app, env };
}

describe("desired app configuration", () => {
  test("diffs and applies a complete manifest spec without deploying code", async () => {
    const { app, env } = seedApp();
    const req = {
      app_name: app.name,
      git_repo: "https://github.com/acme/new",
      git_branch: "release",
      dockerfile_path: "ops/Dockerfile",
      docker_context: "services/api",
      container_port: 8080,
      environment_id: env.id,
      env_projection: ["API_KEY"],
      env_vars: [{ key: "API_KEY", value: "secret", secret: true }],
      public: false,
      memory_mb: 1024,
      cpu_limit: 1.5,
      health_check: false,
      internal_protocol: "tcp" as const,
      replicas: 2,
      durability_class: "standard" as const,
      placement_pool: "workers",
      scale_to_zero_after: 300,
      manifest_path: ".ocd-deploy.json",
      manifest_hash: "abc123",
    };

    expect(diffAppConfig(app, req).map((c) => c.field)).toContain("git_repo");
    await applyAppConfig(app.id, req);

    const updated = db.getApp(app.id)!;
    expect(updated.git_repo).toBe(req.git_repo);
    expect(updated.git_branch).toBe("release");
    expect(updated.dockerfile_path).toBe("ops/Dockerfile");
    expect(updated.container_port).toBe(8080);
    expect(updated.public).toBe(0);
    expect(updated.memory_mb).toBe(1024);
    expect(updated.cpu_limit).toBe(1.5);
    expect(updated.internal_protocol).toBe("tcp");
    expect(updated.desired_replicas).toBe(2);
    expect(updated.durability_class).toBe("standard");
    expect(updated.placement_pool).toBe("workers");
    expect(updated.last_manifest_path).toBe(".ocd-deploy.json");
    expect(updated.last_manifest_hash).toBe("abc123");
    expect(updated.last_manifest_config_revision).toBe(updated.config_revision);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("omitting environment_id retains the app environment", async () => {
    const { app, env } = seedApp();
    await applyAppConfig(app.id, {
      app_name: app.name,
      git_repo: app.git_repo,
      container_port: 3000,
    });
    expect(db.getApp(app.id)?.environment_id).toBe(env.id);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("editing a linked environment advances the desired-config revision", () => {
    const { app, env } = seedApp();
    const before = db.getApp(app.id)!.config_revision;

    db.updateEnvironment(
      env.id,
      env.name,
      serializeEnvVars([{
        key: "API_URL",
        value: "https://example.com",
        secret: false,
        updated_at: new Date().toISOString(),
      }]),
    );

    expect(db.getApp(app.id)!.config_revision).toBe(before + 1);
  });
});
