import { describe, expect, test } from "bun:test";
import { parseServiceCreateArgs } from "./services.ts";

describe("parseServiceCreateArgs", () => {
  test("maps every standalone service deployment option", () => {
    const parsed = parseServiceCreateArgs([
      "database",
      "--type=postgresql",
      "--version=17-pgmq",
      "--volume-size=40",
      "--env=production",
      "--env-prefix=DATABASE",
      "--domain=db.example.com",
      "--set=POSTGRES_DB=app",
      "--set=PGDATA=/var/lib/postgresql/data/pgdata",
    ]);

    expect(parsed).toEqual({
      ok: true,
      value: {
        name: "database",
        serviceType: "postgresql",
        version: "17-pgmq",
        volumeSize: 40,
        environment: "production",
        envPrefix: "DATABASE",
        domain: "db.example.com",
        envOverrides: {
          POSTGRES_DB: "app",
          PGDATA: "/var/lib/postgresql/data/pgdata",
        },
      },
    });
  });

  test("requires a name and catalog type", () => {
    expect(parseServiceCreateArgs(["database"])).toEqual({
      ok: false,
      error: "--type is required",
    });
    expect(parseServiceCreateArgs(["--type=redis"])).toEqual({
      ok: false,
      error: "Service name is required",
    });
  });

  test("rejects invalid numeric and unknown options", () => {
    expect(parseServiceCreateArgs(["db", "--type=postgresql", "--volume-size=zero"])).toEqual({
      ok: false,
      error: 'Invalid --volume-size "zero" (expected a positive number)',
    });
    expect(parseServiceCreateArgs(["db", "--type=postgresql", "--wat"])).toEqual({
      ok: false,
      error: "Unknown option: --wat",
    });
  });
});
