import { describe, expect, test } from "bun:test";
import {
  appIsAffectedByFiles,
  buildStackServiceSpecs,
  certifiedStagingExistingKeys,
  classifyLocalStackReconcile,
  expandAppDependents,
  mergeStagingEnv,
} from "./stack.ts";

describe("buildStackServiceSpecs", () => {
  test("maps every managed-service manifest field to the stack request", () => {
    expect(
      buildStackServiceSpecs({
        name: "production",
        services: {
          database: {
            type: "postgresql",
            version: "17-pgmq",
            volume_size: 40,
            env_overrides: {
              PGDATA: "/var/lib/postgresql/data/pgdata",
            },
            domain: "database.example.com",
            staging: { volume_size: 10, env_overrides: { POSTGRES_DB: "staging" } },
          },
        },
        apps: {
          api: { manifest: "api/.ocd-deploy.json" },
        },
      }),
    ).toEqual([
      {
        key: "database",
        type: "postgresql",
        version: "17-pgmq",
        volume_size: 40,
        env_overrides: {
          PGDATA: "/var/lib/postgresql/data/pgdata",
        },
        domain: "database.example.com",
        staging: { volume_size: 10, env_overrides: { POSTGRES_DB: "staging" } },
        needs: undefined,
      },
    ]);
  });
});

describe("stack reconciliation mode", () => {
  const desired = {
    key: "web", git_repo: "https://github.com/acme/repo", git_sha: "new",
    container_port: 3000, dockerfile_path: "Dockerfile", docker_context: ".",
    manifest_path: "apps/web/.ocd-deploy.json", manifest_hash: "new-hash",
  } as any;
  const existing = {
    deployed_commit: "abc1234", git_repo: desired.git_repo, git_branch: "",
    dockerfile_path: "Dockerfile", docker_context: ".", image_ref: "",
    build_cache_ref: "", container_port: 3000, public: 1, memory_mb: 0,
    cpu_limit: 0, health_check_mode: "http", health_check_path: "",
    health_check_command: "", health_check_file: "", health_check_max_age_seconds: 0,
    internal_protocol: "http", sticky: 0, rate_limit_rps: 0, ip_allowlist: "",
    compress: 0, public_port: null, public_protocol: "tcp", placement_pool: "general",
    scale_to_zero_after: 0, webhook_enabled: 0, webhook_branch: "main", webhook_path: "",
    webhook_paths: null, webhook_paths_ignore: [], webhook_wait_for_ci: 0,
    desired_replicas: 1, min_replicas: 1, max_replicas: 1, autoscale_enabled: 0,
    desired_volume_id: "", desired_volume_size: 0, desired_volume_path: "/data",
  };

  test("manifest-only changes avoid a rebuild", () => {
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

  test("application source changes require a build", () => {
    expect(classifyLocalStackReconcile(existing, desired, ["src/index.ts"], "ocd-stack.json")).toBe("build");
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

  test("matches only the canonical manifest and build context", () => {
    const app = {
      key: "worker",
      app_name: "worker",
      git_repo: "https://github.com/acme/repo",
      container_port: 3000,
      manifest_path: "apps/worker/.ocd-deploy.json",
      docker_context: "apps/worker",
      dockerfile_path: "apps/worker/Dockerfile",
    };
    expect(appIsAffectedByFiles(app, ["apps/worker/src/index.ts"])).toBe(true);
    expect(appIsAffectedByFiles(app, ["apps/api/src/index.ts"])).toBe(false);
  });
});
