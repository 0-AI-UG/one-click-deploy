import { describe, test, expect, spyOn } from "bun:test";
import { validateDeployManifest, validateStackManifest } from "./manifest-validate.ts";
import type { DeployManifest, StackManifest } from "./rpc.ts";

// Compile-time guard: the `z.infer`-derived types must stay structurally
// compatible with how the rest of the codebase reads a manifest (e.g.
// stack-spec.ts reads health_check?.enabled, build?.container_port). If the
// schema drifts from these shapes, this file stops type-checking.
const _deploy: DeployManifest = {
  name: "web",
  build: { container_port: 3000 },
  env: [{ key: "PORT", default: "3000", required: false, secret: false }],
  volume: { size: 5, path: "/data" },
  health_check: { enabled: false, path: "/healthz" },
  internal_protocol: "http",
  public_port: "auto",
  public_protocol: "tcp",
  domain: "web.example.com",
  git_branch: "release",
  env_projection: ["DATABASE_URL"],
  environment: "production",
  auth: { enabled: true, password_env: "OCD_BASIC_AUTH_PASSWORD" },
  placement_pool: "production",
  scale_to_zero_after: 0,
  autoscaling: {
    enabled: true,
    min_replicas: 1,
    max_replicas: 4,
    cpu_threshold: 80,
    memory_threshold: 85,
    requests_per_minute: 0,
    cooldown_seconds: 300,
  },
};
const _enabled: boolean | undefined = _deploy.health_check?.enabled;
const _port: number | undefined = _deploy.build?.container_port;
const _stack: StackManifest = {
  name: "s",
  services: { db: { type: "postgres" } },
  apps: { web: { manifest: "web/.ocd-deploy.json", needs: ["db"] } },
};
void _enabled;
void _port;
void _stack;

const validApp = {
  name: "web",
  volume: null,
  build: { container_port: 3000 },
  env: [{ key: "PORT", default: "3000" }],
  health_check: { enabled: false },
  internal_protocol: "http" as const,
};

describe("validateDeployManifest", () => {
  test("accepts recognized $llm metadata without warnings", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ ...validApp, $llm: { purpose: "worker" } }, ".ocd-deploy.json")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("validates exact HTTP readiness statuses", () => {
    expect(() => validateDeployManifest({
      ...validApp,
      health_check: { mode: "http", path: "/ready", expected_statuses: [200, 204] },
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      ...validApp,
      health_check: { mode: "http", expected_statuses: [700] },
    }, ".ocd-deploy.json")).toThrow();
  });
  test("accepts immutable image artifacts only by digest", () => {
    const digest = "a".repeat(64);
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, image: { ref: `ghcr.io/acme/worker@sha256:${digest}` } },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, image: { ref: "ghcr.io/acme/worker:latest" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
  });

  test("validates truthful worker and job health contracts", () => {
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, health_check: { mode: "exec", command: "test -f /tmp/ready" } },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, health_check: { mode: "exec" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
    expect(() =>
      validateDeployManifest(
        {
          name: "cron",
          volume: null,
          health_check: {
            mode: "periodic_job",
            file: "/run/last-success",
            max_age_seconds: 3600,
          },
        },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "cron", volume: null, health_check: { mode: "periodic_job", file: "/run/last-success" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
  });
  test("a correct manifest passes", () => {
    expect(() => validateDeployManifest(validApp, "docker/.ocd-deploy.json")).not.toThrow();
  });

  test("health_check boolean (the incident) fails with a clear message", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, name: "db", health_check: false }, "docker/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("docker/.ocd-deploy.json");
    expect(msg).toContain("health_check: expected health-check object, got boolean (false)");
  });

  test("bad internal_protocol enum fails", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, name: "web", internal_protocol: "tpc" }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('internal_protocol: expected "http" | "tcp", got "tpc"');
  });

  test("missing name fails", () => {
    expect(() => validateDeployManifest({ volume: null }, "a/.ocd-deploy.json")).toThrow(/name:/);
  });

  test("collects multiple issues at once", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, name: "web", public: "yes", health_check: false }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("public: expected boolean, got \"yes\"");
    expect(msg).toContain("health_check: expected health-check object");
  });

  test("wrong-typed build / container_port fails", () => {
    expect(() => validateDeployManifest({ volume: null, name: "web", build: { container_port: "3000" } }, "a")).toThrow(
      /build\.container_port: expected integer 1-65535, got "3000"/,
    );
  });

  test("unknown key fails by default", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ volume: null, name: "web", futureField: 1 }, "a/.ocd-deploy.json"))
      .toThrow(/futureField: unknown key/);
    expect(warn).not.toHaveBeenCalled();
    expect(() => validateDeployManifest(
      { volume: null, name: "web", futureField: 1 },
      "a/.ocd-deploy.json",
      { allowUnknown: true },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Manifest a/.ocd-deploy.json: unknown key "futureField" (ignored by --allow-unknown)',
    );
    warn.mockRestore();
  });

  test("durability_class validates", () => {
    expect(() =>
      validateDeployManifest({ volume: null, name: "web", durability_class: "high" }, "a/.ocd-deploy.json"),
    ).not.toThrow();
  });

  test("CLI-focused domain, branch, environment projection, auth and placement fields validate", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        domain: "web.example.com",
        git_branch: "release",
        env_projection: [],
        auth: { enabled: true, password_env: "OCD_BASIC_AUTH_PASSWORD" },
        placement_pool: "production",
        scale_to_zero_after: 0,
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        auth: { enabled: true, password_env: "not-valid!" },
      }, "a/.ocd-deploy.json"),
    ).toThrow(/auth\.password_env/);
  });

  test("webhook.staging boolean validates", () => {
    expect(() =>
      validateDeployManifest(
        { name: "web", volume: null, webhook: { enabled: true, branch: "main", staging: true } },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
  });

  test("webhook paths and paths_ignore validate as repository globs", () => {
    expect(() => validateDeployManifest({
      name: "web",
      volume: null,
      webhook: {
        enabled: true,
        paths: ["services/web/**", "packages/core/**", "package.json"],
        paths_ignore: ["services/web/**/*.md"],
      },
    }, "a/.ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      name: "web", volume: null, webhook: { paths: [] },
    }, "a/.ocd-deploy.json")).toThrow(/at least one pattern/);
    expect(() => validateDeployManifest({
      name: "web", volume: null, webhook: { paths: ["!ios/**"] },
    }, "a/.ocd-deploy.json")).toThrow(/inline !patterns/);
  });

  test("rejects path and paths together", () => {
    expect(() => validateDeployManifest({
      name: "web",
      volume: null,
      webhook: { path: "services/web", paths: ["services/web/**"] },
    }, "a/.ocd-deploy.json")).toThrow(/cannot be used together/);
  });

  test("environment selectors and complete autoscaling policy validate", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        environment: "production",
        replicas: 2,
        autoscaling: {
          enabled: true,
          min_replicas: 1,
          max_replicas: 5,
          cpu_threshold: 80,
          memory_threshold: 85,
          requests_per_minute: 100,
          cooldown_seconds: 300,
        },
        webhook: {
          enabled: true,
          staging: true,
          staging_environment: "staging",
        },
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        replicas: 3,
        autoscaling: { max_replicas: 2 },
      }, "a/.ocd-deploy.json"),
    ).toThrow(/autoscaling\.max_replicas/);
  });

  test("wrong-typed webhook.staging fails", () => {
    expect(() =>
      validateDeployManifest(
        { name: "web", volume: null, webhook: { staging: "yes" } },
        "a/.ocd-deploy.json",
      ),
    ).toThrow(/staging|boolean/i);
  });

  test("bad durability_class enum fails", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, name: "web", durability_class: "gold" }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("durability_class");
  });

  test("minimal explicit no-volume manifest validates", () => {
    expect(() => validateDeployManifest({ volume: null, name: "web" }, "a/.ocd-deploy.json")).not.toThrow();
  });

  test("legacy top-level `environments` key is rejected", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", volume: null, environments: { staging: { branch: "develop" } } },
        "a/.ocd-deploy.json",
      ),
    ).toThrow(/environments: unknown key/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("validateStackManifest", () => {
  const validStack = {
    name: "myapp",
    services: { db: { type: "postgres" } },
    apps: {
      web: { manifest: "web/.ocd-deploy.json", needs: ["db"] },
      worker: { manifest: "worker/.ocd-deploy.json", needs: ["web"] },
    },
  };

  test("a correct stack passes", () => {
    expect(() => validateStackManifest(validStack, "ocd-stack.json")).not.toThrow();
  });

  test("managed service custom domains validate", () => {
    expect(() => validateStackManifest({
      name: "search",
      services: {
        search: { type: "meilisearch", domain: "search.example.com" },
      },
      apps: { web: { manifest: "web/.ocd-deploy.json" } },
    }, "ocd-stack.json")).not.toThrow();
  });

  test("managed service staging overrides and stack staging env declarations validate", () => {
    expect(() => validateStackManifest({
      ...validStack,
      staging_env: [
        { key: "PUBLIC_BASE_URL", default: "https://staging.example.com" },
        { key: "STRIPE_SECRET_KEY", required: true, secret: true },
      ],
      services: {
        db: {
          type: "postgresql",
          volume_size: 20,
          staging: { volume_size: 10, env_overrides: { POSTGRES_DB: "staging" } },
        },
      },
    }, "ocd-stack.json")).not.toThrow();
  });

  test("stack app environment projections accept selected keys and an empty list", () => {
    expect(() => validateStackManifest({
      $schema: 1,
      name: "projected",
      apps: {
        api: { manifest: "api/.ocd-deploy.json", env: ["DATABASE_URL", "JWT_SECRET"] },
        docs: { manifest: "docs/.ocd-deploy.json", env: [] },
      },
    }, "ocd-stack.json")).not.toThrow();

    expect(() => validateStackManifest({
      $schema: 1,
      name: "bad-projection",
      apps: {
        api: { manifest: "api/.ocd-deploy.json", env: "DATABASE_URL" },
      },
    }, "ocd-stack.json")).toThrow("apps.api.env");
  });

  test("env_all opts into all keys and cannot combine with env", () => {
    expect(() => validateStackManifest({
      name: "legacy",
      apps: { web: { manifest: "web/.ocd-deploy.json", env_all: true } },
    }, "ocd-stack.json")).not.toThrow();
    expect(() => validateStackManifest({
      name: "ambiguous",
      apps: { web: { manifest: "web/.ocd-deploy.json", env: ["SAFE"], env_all: true } },
    }, "ocd-stack.json")).toThrow(/env_all.*cannot be combined/i);
  });

  test("needs referencing a missing app key fails", () => {
    let msg = "";
    try {
      validateStackManifest(
        { name: "s", apps: { web: { manifest: "web/.ocd-deploy.json", needs: ["ghost"] } } },
        "ocd-stack.json",
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('apps.web.needs[0]: references "ghost", which is not a declared app or service key');
  });

  test("empty apps fails", () => {
    expect(() => validateStackManifest({ name: "s", apps: {} }, "ocd-stack.json")).toThrow(/apps:/);
  });

  test("app entry with non-string manifest fails", () => {
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: 5 } } }, "ocd-stack.json"),
    ).toThrow(/apps\.web\.manifest: expected a manifest path string, got number \(5\)/);
  });

  test("unknown top-level key fails unless compatibility is explicit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: "w" } }, extra: true }, "ocd-stack.json"),
    ).toThrow(/extra: unknown key/);
    expect(() => validateStackManifest(
      { name: "s", apps: { web: { manifest: "w" } }, extra: true },
      "ocd-stack.json",
      { allowUnknown: true },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Manifest ocd-stack.json: unknown key "extra" (ignored by --allow-unknown)',
    );
    warn.mockRestore();
  });
});
