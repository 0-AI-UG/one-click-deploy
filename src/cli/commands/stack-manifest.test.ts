import { describe, expect, test } from "bun:test";
import {
  certifiedStagingExistingKeys,
  classifyLocalStackReconcile,
  expandAppDependents,
  mergeStagingEnv,
} from "./stack.ts";

describe("stack reconciliation mode", () => {
  const desired = {
    key: "web", image_ref: `ghcr.io/acme/web@sha256:${"b".repeat(64)}`,
    container_port: 3000,
    manifest_path: "apps/web/.ocd-deploy.json", manifest_hash: "new-hash",
  } as any;
  const existing = {
    image_ref: desired.image_ref,
    container_port: 3000, public: 1, memory_mb: 0,
    cpu_limit: 0, health_check_mode: "http", health_check_path: "",
    health_check_command: "", health_check_file: "", health_check_max_age_seconds: 0,
    internal_protocol: "http", sticky: 0, rate_limit_rps: 0, ip_allowlist: "",
    compress: 0, public_port: null, public_protocol: "tcp", placement_pool: "general",
    scale_to_zero_after: 0,
    desired_replicas: 1, min_replicas: 1, max_replicas: 1, autoscale_enabled: 0,
    desired_volume_id: "", desired_volume_size: 0, desired_volume_path: "/data",
  };

  test("manifest-only changes avoid an artifact rollout", () => {
    expect(classifyLocalStackReconcile(
      existing, desired, [desired.manifest_path], "ocd-stack.json",
    )).toBe("control");
    expect(classifyLocalStackReconcile(
      existing, desired, ["apps/worker/.ocd-deploy.json"], "ocd-stack.json",
      ["apps/worker/.ocd-deploy.json"],
    )).toBe("control");
  });

  test("container changes reuse the existing image", () => {
    expect(classifyLocalStackReconcile(
      existing, { ...desired, container_port: 4000 }, [desired.manifest_path], "ocd-stack.json",
    )).toBe("runtime");
  });

  test("an immutable image change requires an artifact rollout", () => {
    const changed = { ...desired, image_ref: `ghcr.io/acme/web@sha256:${"c".repeat(64)}` };
    expect(classifyLocalStackReconcile(existing, changed)).toBe("artifact");
  });
});

describe("certifiedStagingExistingKeys", () => {
  test("does not let copied production keys satisfy required staging declarations", () => {
    const env = {
      id: 53,
      name: "copied-staging",
      env_vars: [{ key: "DATABASE_URL" }, { key: "PUBLIC_BASE_URL" }],
    };
    expect([...certifiedStagingExistingKeys(env, "[]")]).toEqual([]);
    expect([...certifiedStagingExistingKeys(env, '["PUBLIC_BASE_URL"]')]).toEqual(["PUBLIC_BASE_URL"]);
  });

  test("an explicit empty staging default clears a copied production value", () => {
    expect(mergeStagingEnv(
      [{ key: "RESEND_API_KEY", default: "", secret: true }],
      {},
      new Set(),
    )).toEqual({
      entries: [{ key: "RESEND_API_KEY", value: "", secret: true }],
      requiredMissing: [],
    });
  });
});

describe("partial stack selection", () => {
  const apps = {
    api: { manifest: "apps/api/.ocd-deploy.json" },
    worker: { manifest: "apps/worker/.ocd-deploy.json", needs: ["api"] },
    admin: { manifest: "apps/admin/.ocd-deploy.json", needs: ["api"] },
  };

  test("expands downstream dependents transitively", () => {
    expect([...expandAppDependents(["api"], apps)].sort()).toEqual(["admin", "api", "worker"]);
    expect([...expandAppDependents(["worker"], apps)]).toEqual(["worker"]);
  });

});
