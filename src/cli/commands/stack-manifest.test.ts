import { describe, expect, test } from "bun:test";
import { buildStackServiceSpecs, certifiedStagingExistingKeys, mergeStagingEnv } from "./stack.ts";

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
