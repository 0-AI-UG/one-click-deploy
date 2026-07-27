import { describe, expect, test } from "bun:test";
import { buildStackServiceSpecs } from "./stack.ts";

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
        needs: undefined,
      },
    ]);
  });
});
