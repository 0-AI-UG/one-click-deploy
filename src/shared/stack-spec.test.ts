import { describe, expect, test } from "bun:test";
import type { DeployManifest, StackManifest } from "./rpc.ts";
import { buildStackAppSpec, validateStackReferences } from "./stack-spec.ts";

const BUILD = {
  repository: "https://github.com/acme/app",
  branch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  image_repository: "ghcr.io/acme/app",
  webhook: true,
} as const;

describe("buildStackAppSpec", () => {
  test("carries the full canonical app manifest deployment spec into a stack", () => {
    const manifest: DeployManifest = {
      name: "API",
      build: BUILD,
      domain: "manifest.example.com",
      container_port: 8080,
      env: { DATABASE_URL: { from: "environment.DATABASE_URL" } },
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
    };
    const entry: StackManifest["apps"][string] = {
      manifest: "services/api/.ocd-deploy.json",
      needs: ["database"],
      domain: "stack.example.com",
      public: false,
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
      build: BUILD,
      container_port: 8080,
      env: { DATABASE_URL: { from: "environment.DATABASE_URL" } },
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
      volume_id: "",
      volume_size: 20,
      volume_path: "/var/lib/app",
      extra_volumes: [{ host_path: "/srv/shared", container_path: "/shared" }],
    });
  });

  test("uses app-manifest domain and env when the stack does not override them", () => {
    const spec = buildStackAppSpec(
      "web",
      { manifest: ".ocd-deploy.json" },
      {
        name: "Web",
        build: BUILD,
        volume: null,
        domain: "web.example.com",
        env: {},
        durability_class: "standard",
      },
      "https://github.com/acme/web",
      "",
    );
    expect(spec.domain).toBe("web.example.com");
    expect(spec.env).toEqual({});
    expect(spec.durability_class).toBe("standard");
  });

  test("infers dependencies from explicit output references", () => {
    const spec = buildStackAppSpec("web", { manifest: "web.json", needs: ["cache"] }, {
      name: "web", image: "nginx", volume: null,
      env: { URL: { from: "apps.database.outputs.URL" }, MODE: "production" },
    }, "", "");
    expect(spec.needs).toEqual(["cache", "database"]);
    expect(spec.env).toEqual({ URL: { from: "apps.database.outputs.URL" }, MODE: "production" });
  });
});

describe("stack reference validation", () => {
  const app = (key: string, env = {}, outputs = {}) => buildStackAppSpec(key, { manifest: `${key}.json` }, {
    name: key, image: "nginx", volume: null, env, outputs,
  }, "", "");
  test("checks output existence", () => {
    const web = app("web", { URL: { from: "apps.database.outputs.URL" } });
    expect(() => validateStackReferences([web])).toThrow("missing output");
    expect(() => validateStackReferences([web, app("database", {}, { URL: { template: "{app.host}:{app.port}" } })])).not.toThrow();
  });
  test("rejects reference cycles", () => {
    const output = { URL: { template: "{app.host}" } };
    expect(() => validateStackReferences([
      app("a", { URL: { from: "apps.b.outputs.URL" } }, output),
      app("b", { URL: { from: "apps.a.outputs.URL" } }, output),
    ])).toThrow("cycle");
  });
});
