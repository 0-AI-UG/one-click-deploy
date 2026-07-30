import { describe, expect, test } from "bun:test";
import type { DeployManifest, StackManifest } from "./rpc.ts";
import { buildStackAppSpec } from "./stack-spec.ts";

describe("buildStackAppSpec", () => {
  test("carries the full canonical app manifest deployment spec into a stack", () => {
    const manifest: DeployManifest = {
      name: "API",
      domain: "manifest.example.com",
      git_branch: "release",
      build: {
        dockerfile: "Dockerfile.prod",
        context: "services/api",
        container_port: 8080,
      },
      env_projection: ["DATABASE_URL"],
      environment: "production",
      replicas: 3,
      public: true,
      memory_mb: 1024,
      cpu_limit: 1.5,
      health_check: { enabled: true, path: "/ready" },
      internal_protocol: "http",
      sticky: true,
      rate_limit_rps: 100,
      ip_allowlist: "10.0.0.0/8",
      compress: true,
      public_port: null,
      public_protocol: "tcp",
      durability_class: "high",
      placement_pool: "production",
      scale_to_zero_after: 0,
      autoscaling: {
        enabled: true,
        min_replicas: 2,
        max_replicas: 6,
        cpu_threshold: 75,
        memory_threshold: 80,
        requests_per_minute: 120,
        cooldown_seconds: 180,
      },
      volume: { size: 20, path: "/var/lib/app" },
      extra_volumes: [{ host_path: "/srv/shared", container_path: "/shared" }],
      webhook: {
        enabled: true,
        branch: "release",
        path: "services/api",
        wait_for_ci: true,
        staging: true,
        staging_environment: "staging",
      },
    };
    const entry: StackManifest["apps"][string] = {
      manifest: "services/api/.ocd-deploy.json",
      needs: ["database"],
      domain: "stack.example.com",
      public: false,
      env: ["DATABASE_URL", "JWT_SECRET"],
    };

    const spec = buildStackAppSpec(
      "api",
      entry,
      manifest,
      "https://github.com/acme/app",
      "services/api",
    );

    expect(spec).toMatchObject({
      key: "api",
      apply_mode: "manifest",
      needs: ["database"],
      domain: "stack.example.com",
      git_branch: "release",
      dockerfile_path: "services/api/Dockerfile.prod",
      docker_context: "services/api",
      container_port: 8080,
      env_projection: ["DATABASE_URL", "JWT_SECRET"],
      environment: "production",
      replicas: 3,
      public: false,
      memory_mb: 1024,
      cpu_limit: 1.5,
      internal_protocol: "http",
      sticky: true,
      rate_limit_rps: 100,
      ip_allowlist: "10.0.0.0/8",
      health_check_path: "/ready",
      compress: true,
      public_port: null,
      public_protocol: "tcp",
      durability_class: "high",
      placement_pool: "production",
      scale_to_zero_after: 0,
      autoscale_enabled: true,
      min_replicas: 2,
      max_replicas: 6,
      autoscale_cpu_threshold: 75,
      autoscale_mem_threshold: 80,
      autoscale_req_threshold: 120,
      autoscale_cooldown: 180,
      volume_size: 20,
      volume_path: "/var/lib/app",
      extra_volumes: [{ host_path: "/srv/shared", container_path: "/shared" }],
      webhook_enabled: true,
      webhook_branch: "release",
      webhook_path: "services/api",
      webhook_wait_for_ci: true,
      webhook_staging: true,
      webhook_staging_environment: "staging",
    });
  });

  test("uses app-manifest domain and projection when the stack does not override them", () => {
    const spec = buildStackAppSpec(
      "web",
      { manifest: ".ocd-deploy.json" },
      {
        name: "Web",
        domain: "web.example.com",
        env_projection: [],
        durability_class: "standard",
      },
      "https://github.com/acme/web",
      "",
    );
    expect(spec.domain).toBe("web.example.com");
    expect(spec.env_projection).toEqual([]);
    expect(spec.durability_class).toBe("standard");
  });

  test("defaults a new stack member to only child-manifest declarations", () => {
    const spec = buildStackAppSpec(
      "docs",
      { manifest: "docs/.ocd-deploy.json", needs: ["api"] },
      {
        name: "Docs",
        env: [
          { key: "DOCS_THEME", default: "light" },
          { key: "SEARCH_TOKEN", required: true, secret: true },
        ],
      },
      "https://github.com/acme/docs",
      "docs",
    );
    expect(spec.env_projection_mode).toBe("declared");
    expect(spec.env_projection).toEqual(["DOCS_THEME", "SEARCH_TOKEN"]);
    expect(spec.declared_env_keys).toEqual(["DOCS_THEME", "SEARCH_TOKEN"]);
  });

  test("requires env_all for explicit access to every shared key", () => {
    const spec = buildStackAppSpec(
      "legacy",
      { manifest: ".ocd-deploy.json", env_all: true },
      { name: "Legacy" },
      "https://github.com/acme/legacy",
      "",
    );
    expect(spec.env_projection_mode).toBe("all");
    expect(spec.env_projection).toBeNull();
  });
});
