import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "./db.ts";
import {
  applyAppConfig,
  classifyAppConfigChanges,
  classifyConfigOnlyChanges,
  diffAppConfig,
} from "./app-config.ts";
import { serializeEnvVars } from "./env-crypto.ts";

const IMAGE_REF = `ghcr.io/acme/app@sha256:${"a".repeat(64)}`;

describe("classifyAppConfigChanges", () => {
  test("separates control, runtime, and artifact changes", () => {
    expect(classifyAppConfigChanges([{ field: "sticky", before: false, after: true }])).toBe("control");
    expect(classifyAppConfigChanges([{ field: "container_port", before: 3000, after: 4000 }])).toBe("runtime");
    expect(classifyAppConfigChanges([{ field: "image_ref", before: "old", after: "new" }])).toBe("artifact");
    expect(classifyAppConfigChanges([
      { field: "container_port", before: 3000, after: 4000 },
      { field: "image_ref", before: "", after: "registry/app@sha256:abc" },
    ])).toBe("artifact");
  });

  test("config-only recreates runtime state while deferring artifact rollout", () => {
    const runtime = { field: "memory_mb", before: 512, after: 1024 };
    const artifact = { field: "image_ref", before: "old", after: "new" };
    expect(classifyConfigOnlyChanges([runtime])).toEqual({ rollout: "runtime", pendingRollout: false });
    expect(classifyConfigOnlyChanges([artifact])).toEqual({ rollout: "control", pendingRollout: true });
    expect(classifyConfigOnlyChanges([runtime, artifact])).toEqual({ rollout: "runtime", pendingRollout: true });
    expect(classifyConfigOnlyChanges([], { environmentChanged: true }))
      .toEqual({ rollout: "runtime", pendingRollout: false });
  });
});

function seedApp() {
  const suffix = randomSuffix();
  const env = db.insertEnvironment(`env-${suffix}`, serializeEnvVars([]));
  const app = db.insertApp({
    name: `app-${suffix}`,
    domain: `${suffix}.example.com`,
    image_ref: IMAGE_REF,
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
      image_ref: `ghcr.io/acme/app@sha256:${"b".repeat(64)}`,
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
      apply_mode: "manifest" as const,
      autoscale_enabled: true,
      min_replicas: 2,
      max_replicas: 5,
      autoscale_cpu_threshold: 70,
      autoscale_mem_threshold: 75,
      autoscale_req_threshold: 100,
      autoscale_cooldown: 180,
    };

    expect(diffAppConfig(app, req).map((c) => c.field)).toContain("image_ref");
    await applyAppConfig(app.id, req);

    const updated = db.getApp(app.id)!;
    expect(updated.image_ref).toBe(req.image_ref);
    expect(updated.container_port).toBe(8080);
    expect(updated.public).toBe(0);
    expect(updated.memory_mb).toBe(1024);
    expect(updated.cpu_limit).toBe(1.5);
    expect(updated.internal_protocol).toBe("tcp");
    expect(updated.desired_replicas).toBe(2);
    expect(updated.durability_class).toBe("standard");
    expect(updated.placement_pool).toBe("workers");
    expect(updated.autoscale_enabled).toBe(1);
    expect(updated.min_replicas).toBe(2);
    expect(updated.max_replicas).toBe(5);
    expect(updated.autoscale_cpu_threshold).toBe(70);
    expect(updated.autoscale_mem_threshold).toBe(75);
    expect(updated.autoscale_req_threshold).toBe(100);
    expect(updated.autoscale_cooldown).toBe(180);
    expect(updated.last_manifest_path).toBe(".ocd-deploy.json");
    expect(updated.last_manifest_hash).toBe("abc123");
    expect(updated.last_manifest_config_revision).toBe(updated.config_revision);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("omitting environment_id retains the app environment", async () => {
    const { app, env } = seedApp();
    await applyAppConfig(app.id, {
      app_name: app.name,
      image_ref: app.image_ref,
      container_port: 3000,
    });
    expect(db.getApp(app.id)?.environment_id).toBe(env.id);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("manifest mode resets omitted fields and supports explicit detach", async () => {
    const { app } = seedApp();
    db.updateAppScaling(app.id, {
      desired_replicas: 3,
      min_replicas: 2,
      max_replicas: 8,
      autoscale_enabled: true,
      autoscale_cpu_threshold: 60,
    });
    db.updateAppExtraVolumes(app.id, ["/srv/data:/data"]);
    await applyAppConfig(app.id, {
      apply_mode: "manifest",
      app_name: app.name,
      image_ref: app.image_ref,
      container_port: 3000,
      environment_id: null,
      health_check: false,
    });
    const updated = db.getApp(app.id)!;
    expect(updated.environment_id).toBeNull();
    expect(updated.health_check).toBe(0);
    expect(updated.health_check_mode).toBe("container");
    expect(updated.desired_replicas).toBe(1);
    expect(updated.min_replicas).toBe(1);
    expect(updated.max_replicas).toBe(1);
    expect(updated.autoscale_enabled).toBe(0);
    expect(updated.autoscale_cpu_threshold).toBe(80);
    expect(updated.autoscale_mem_threshold).toBe(85);
    expect(updated.autoscale_req_threshold).toBe(0);
    expect(updated.autoscale_cooldown).toBe(300);
    expect(db.parseExtraVolumes(updated.extra_volumes)).toEqual([]);
  });

  test("records primary-volume intent without mutating observed attachment state", async () => {
    const { app } = seedApp();
    db.updateAppVolume(app.id, "vol-old", "/mnt/vol-old:/old", true);
    db.updateAppDesiredVolume(app.id, { volumeId: "vol-old", sizeGb: 20, mountPath: "/old" });

    const req = {
      apply_mode: "manifest" as const,
      app_name: app.name,
      image_ref: app.image_ref,
      container_port: 3000,
      volume_id: "vol-new",
      volume_size: 40,
      volume_path: "/data",
    };
    expect(diffAppConfig(db.getApp(app.id)!, req).map((change) => change.field)).toEqual(
      expect.arrayContaining(["desired_volume_id", "desired_volume_size", "desired_volume_path"]),
    );

    await applyAppConfig(app.id, req);
    const updated = db.getApp(app.id)!;
    expect(updated.desired_volume_id).toBe("vol-new");
    expect(updated.desired_volume_size).toBe(40);
    expect(updated.desired_volume_path).toBe("/data");
    expect(updated.volume_id).toBe("vol-old");
    expect(updated.volume_mount).toBe("/mnt/vol-old:/old");
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
