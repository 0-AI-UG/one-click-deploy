import { describe, test, expect, spyOn } from "bun:test";
import { validateDeployManifest, validateStackManifest } from "./manifest-validate.ts";
import type { DeployManifest, StackManifest } from "./rpc.ts";

// Compile-time guard: the `z.infer`-derived types must stay structurally
// compatible with how the rest of the codebase reads a manifest (e.g.
// stack-spec.ts reads health_check?.enabled and container_port). If the
// schema drifts from these shapes, this file stops type-checking.
const BUILD = {
  repository: "https://github.com/acme/web",
  branch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  image_repository: "ghcr.io/acme/web",
  webhook: true,
} as const;
const _deploy: DeployManifest = {
  name: "web",
  build: BUILD,
  container_port: 3000,
  env: { PORT: "3000" },
  volume: { size: 5, path: "/data" },
  health_check: { enabled: false, path: "/healthz" },
  internal_protocol: "http",
  public_port: "auto",
  public_protocol: "tcp",
  domain: "web.example.com",
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
const _port: number | undefined = _deploy.container_port;
const _stack: StackManifest = {
  name: "s",
  apps: { web: { manifest: "web/.ocd-deploy.json" } },
};
void _enabled;
void _port;
void _stack;

const validApp = {
  name: "web",
  volume: null,
  build: BUILD,
  container_port: 3000,
  env: { PORT: "3000" },
  health_check: { enabled: false },
  internal_protocol: "http" as const,
};

describe("validateDeployManifest", () => {
  test("accepts arbitrary image apps and rejects ambiguous delivery sources", () => {
    expect(() => validateDeployManifest({
      name: "database",
      image: "postgres:17-alpine",
      container_port: 5432,
      volume: { size: 10, path: "/var/lib/postgresql/data" },
      env: { POSTGRES_PASSWORD: { from: "environment.POSTGRES_PASSWORD" } },
      outputs: {
        URL: { template: "postgresql://postgres:{env.POSTGRES_PASSWORD}@{app.host}:{app.port}/postgres", secret: true },
      },
      cap_add: ["CHOWN", "SETUID", "SETGID"],
      post_start: { command: "pg_isready" },
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      name: "database",
      image: { ref: "postgres:17-alpine" },
      volume: null,
    }, ".ocd-deploy.json")).toThrow("expected an OCI image reference");
    expect(() => validateDeployManifest({ ...validApp, image: "nginx:alpine" }, ".ocd-deploy.json"))
      .toThrow("exactly one of build or image");
    const { build: _build, ...withoutSource } = validApp;
    expect(() => validateDeployManifest(withoutSource, ".ocd-deploy.json"))
      .toThrow("exactly one of build or image");
  });

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
  test("accepts safe OCD build contracts and rejects tagged push repositories", () => {
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, build: { ...BUILD, image_repository: "ghcr.io/acme/worker" } },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, build: { ...BUILD, image_repository: "ghcr.io/acme/worker:latest" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
  });

  test("pins the supported build platform and allows an explicit cache opt-out", () => {
    expect(() => validateDeployManifest({
      name: "worker",
      volume: null,
      build: { ...BUILD, platform: "linux/amd64", cache: false },
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      name: "worker",
      volume: null,
      build: { ...BUILD, platform: "linux/arm64" },
    }, ".ocd-deploy.json")).toThrow("linux/amd64");
  });

  test("validates truthful worker and job health contracts", () => {
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, build: BUILD, health_check: { mode: "exec", command: "test -f /tmp/ready" } },
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
          build: BUILD,
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

  test("wrong-typed container_port fails", () => {
    expect(() => validateDeployManifest({ volume: null, name: "web", build: BUILD, container_port: "3000" }, "a")).toThrow(
      /container_port: expected integer 1-65535, got "3000"/,
    );
  });

  test("unknown key fails by default", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ volume: null, name: "web", futureField: 1 }, "a/.ocd-deploy.json"))
      .toThrow(/futureField: unknown key/);
    expect(warn).not.toHaveBeenCalled();
    expect(() => validateDeployManifest(
      { volume: null, name: "web", build: BUILD, futureField: 1 },
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
      validateDeployManifest({ volume: null, name: "web", build: BUILD, durability_class: "high" }, "a/.ocd-deploy.json"),
    ).not.toThrow();
  });

  test("CLI-focused domain, environment projection, auth and placement fields validate", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        build: BUILD,
        domain: "web.example.com",
        env: {},
        auth: { enabled: true, password_env: "OCD_BASIC_AUTH_PASSWORD" },
        placement_pool: "production",
        scale_to_zero_after: 0,
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        build: BUILD,
        auth: { enabled: true, password_env: "not-valid!" },
      }, "a/.ocd-deploy.json"),
    ).toThrow(/auth\.password_env/);
  });

  test("environment selectors and complete autoscaling policy validate", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        build: BUILD,
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
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null,
        build: BUILD,
        replicas: 3,
        autoscaling: { max_replicas: 2 },
      }, "a/.ocd-deploy.json"),
    ).toThrow(/autoscaling\.max_replicas/);
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
    expect(() => validateDeployManifest({ volume: null, name: "web", build: BUILD }, "a/.ocd-deploy.json")).not.toThrow();
  });

  test("legacy top-level `environments` key is rejected", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", volume: null, build: BUILD, environments: { staging: { branch: "develop" } } },
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
    apps: {
      web: { manifest: "web/.ocd-deploy.json" },
      worker: { manifest: "worker/.ocd-deploy.json", needs: ["web"] },
    },
  };

  test("a correct stack passes", () => {
    expect(() => validateStackManifest(validStack, "ocd-stack.json")).not.toThrow();
  });

  test("selects an existing staging environment", () => {
    expect(() => validateStackManifest({ ...validStack, staging_environment: "staging" }, "ocd-stack.json")).not.toThrow();
  });
  test("rejects removed stack configuration fields", () => {
    for (const field of ["env", "env_all"]) {
      expect(() => validateStackManifest({ name: "s", apps: { web: { manifest: "web.json", [field]: [] } } }, "ocd-stack.json")).toThrow(field);
    }
    expect(() => validateStackManifest({ ...validStack, staging_env: [] }, "ocd-stack.json")).toThrow("staging_env");
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
    expect(msg).toContain('apps.web.needs[0]: references "ghost", which is not a declared app key');
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

describe("explicit runtime environment", () => {
  test("accepts literals and resource references", () => {
    expect(() => validateDeployManifest({ ...validApp, env: {
      EMPTY: "", MODE: "production", TOKEN: { from: "environment.API_TOKEN" },
      DATABASE_URL: { from: "apps.database.outputs.URL" },
    } }, "app.json")).not.toThrow();
  });
  test("rejects removed declarations and malformed references", () => {
    for (const env of [[{ key: "TOKEN" }], { TOKEN: { from: "API_TOKEN" } }, { TOKEN: 1 }, { "BAD-KEY": "value" }]) {
      expect(() => validateDeployManifest({ ...validApp, env }, "app.json")).toThrow("env");
    }
    for (const field of ["env_projection", "exports"]) {
      expect(() => validateDeployManifest({ ...validApp, [field]: {} }, "app.json")).toThrow(field);
    }
  });
  test("rejects unsupported output template placeholders", () => {
    expect(() => validateDeployManifest({ ...validApp, outputs: { URL: { template: "{environment.TOKEN}" } } }, "app.json")).toThrow("template");
  });
});
