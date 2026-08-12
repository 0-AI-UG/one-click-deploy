import { describe, expect, test } from "bun:test";
import {
  appIsAffectedByFiles,
  buildStackServiceSpecs,
  certifiedStagingExistingKeys,
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
