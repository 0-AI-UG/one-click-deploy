import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "./db.ts";
import {
  isSuspiciousSecretKey,
  maskEnvVarsForResponse,
  mergeEnvVarUpdate,
  parseEnvVars,
  platformEnvVars,
  processIncomingEnvVars,
  resolveAppEnvVars,
  serializeEnvVars,
  suspiciousPlaintextKeys,
} from "./env-crypto.ts";

describe("suspicious secret classification", () => {
  test("recognizes credential and connection names without flagging ordinary settings", () => {
    expect(isSuspiciousSecretKey("API_TOKEN")).toBe(true);
    expect(isSuspiciousSecretKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSuspiciousSecretKey("SENTRY_DSN")).toBe(true);
    expect(isSuspiciousSecretKey("DATABASE_URL")).toBe(true);
    expect(isSuspiciousSecretKey("REDIS_URL")).toBe(true);
    expect(isSuspiciousSecretKey("LOG_LEVEL")).toBe(false);
    expect(suspiciousPlaintextKeys([
      { key: "API_TOKEN", value: "secret", secret: false },
      { key: "LOG_LEVEL", value: "info", secret: false },
    ])).toEqual(["API_TOKEN"]);
  });

  test("server converts suspicious plaintext input into encrypted secret storage", async () => {
    const result = await processIncomingEnvVars([
      { key: "DATABASE_URL", value: "postgres://user:pass@db/test", secret: false },
    ]);
    expect(result.entries[0].secret).toBe(true);
    expect(result.entries[0].value).toBe("");
    expect(result.entries[0].encrypted_value).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("postgres://user:pass");
  });

  test("merge path also converts suspicious plaintext while preserving masked ciphertext", async () => {
    const original = await processIncomingEnvVars([
      { key: "API_TOKEN", value: "token-value", secret: true },
    ]);
    const preserved = await mergeEnvVarUpdate(original, [
      { key: "API_TOKEN", value: "••••••••", secret: false },
    ]);
    expect(preserved.entries[0]).toEqual(original.entries[0]);
    expect(parseEnvVars(serializeEnvVars(preserved.entries)).entries[0].secret).toBe(true);
  });
});

describe("platformEnvVars", () => {
  test("HTTP-routed app (internal_protocol=http) gets a port-less http:// internal URL", () => {
    const vars = platformEnvVars({ name: "api", internal_protocol: "http", container_port: 3000 });
    expect(vars).toEqual({
      OCD_INTERNAL_URL: "http://api.ocd.internal",
      OCD_INTERNAL_HOST: "api.ocd.internal",
      OCD_INTERNAL_PORT: "80",
      OCD_DEPLOY_TARGET: "production",
    });
  });

  test("TCP-routed app (internal_protocol=tcp) gets a tcp:// URL on its container port", () => {
    const vars = platformEnvVars({ name: "queue", internal_protocol: "tcp", container_port: 5432 });
    expect(vars).toEqual({
      OCD_INTERNAL_URL: "tcp://queue.ocd.internal:5432",
      OCD_INTERNAL_HOST: "queue.ocd.internal",
      OCD_INTERNAL_PORT: "5432",
      OCD_DEPLOY_TARGET: "production",
    });
  });
});

describe("resolveAppEnvVars platform injection", () => {
  function makeApp(opts: {
    environment_id?: number;
    env_projection?: string[] | null;
    health_check?: boolean;
    internal_protocol?: "http" | "tcp";
  } = {}) {
    const name = `envtest-${randomSuffix()}`;
    return db.insertApp({
      name,
      domain: `${name}.example.com`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
      environment_id: opts.environment_id,
      env_projection: opts.env_projection,
      health_check: opts.health_check,
      internal_protocol: opts.internal_protocol,
    });
  }

  test("injects OCD_INTERNAL_* for an app without an environment", async () => {
    const app = makeApp();
    const vars = await resolveAppEnvVars(app);
    expect(vars.OCD_INTERNAL_URL).toBe(`http://${app.name}.ocd.internal`);
    expect(vars.OCD_INTERNAL_HOST).toBe(`${app.name}.ocd.internal`);
    expect(vars.OCD_INTERNAL_PORT).toBe("80");
    expect(vars.OCD_DEPLOY_TARGET).toBe("production");
  });

  test("injects a non-overridable staging deploy target", async () => {
    const now = new Date().toISOString();
    const env = db.insertEnvironment(
      `envtest-target-${randomSuffix()}`,
      serializeEnvVars([
        { key: "OCD_DEPLOY_TARGET", value: "production", secret: false, updated_at: now },
      ]),
    );
    const app = makeApp({ environment_id: env.id });
    db.setAppTarget(app.id, null, "staging");
    const vars = await resolveAppEnvVars(db.getApp(app.id)!);
    expect(vars.OCD_DEPLOY_TARGET).toBe("staging");
  });

  test("user-defined var with the same key wins over the injected one", async () => {
    const now = new Date().toISOString();
    const env = db.insertEnvironment(
      `envtest-env-${randomSuffix()}`,
      serializeEnvVars([
        { key: "OCD_INTERNAL_URL", value: "http://hand-set.example:8080", secret: false, updated_at: now },
        { key: "OTHER", value: "abc", secret: false, updated_at: now },
      ]),
    );
    const app = makeApp({ environment_id: env.id });
    const vars = await resolveAppEnvVars(app);
    expect(vars.OCD_INTERNAL_URL).toBe("http://hand-set.example:8080");
    expect(vars.OTHER).toBe("abc");
    // Non-overridden platform vars still injected.
    expect(vars.OCD_INTERNAL_HOST).toBe(`${app.name}.ocd.internal`);
    expect(vars.OCD_INTERNAL_PORT).toBe("80");
  });

  test("tcp scheme for a tcp-routed app", async () => {
    const app = makeApp({ internal_protocol: "tcp" });
    const vars = await resolveAppEnvVars(app);
    expect(vars.OCD_INTERNAL_URL).toBe(`tcp://${app.name}.ocd.internal:${app.container_port}`);
  });

  test("projects a shared environment per app while retaining platform variables", async () => {
    const now = new Date().toISOString();
    const env = db.insertEnvironment(
      `envtest-projected-${randomSuffix()}`,
      serializeEnvVars([
        { key: "API_ONLY", value: "yes", secret: false, updated_at: now },
        { key: "WORKER_ONLY", value: "no", secret: false, updated_at: now },
      ]),
    );
    const app = makeApp({ environment_id: env.id, env_projection: ["API_ONLY"] });
    const vars = await resolveAppEnvVars(app);

    expect(vars.API_ONLY).toBe("yes");
    expect(vars.WORKER_ONLY).toBeUndefined();
    expect(vars.OCD_INTERNAL_HOST).toBe(`${app.name}.ocd.internal`);
  });

  test("an empty projection receives platform variables only", async () => {
    const now = new Date().toISOString();
    const env = db.insertEnvironment(
      `envtest-empty-projection-${randomSuffix()}`,
      serializeEnvVars([
        { key: "SHARED", value: "hidden", secret: false, updated_at: now },
      ]),
    );
    const app = makeApp({ environment_id: env.id, env_projection: [] });
    const vars = await resolveAppEnvVars(app);

    expect(vars.SHARED).toBeUndefined();
    expect(vars.OCD_INTERNAL_URL).toBe(`http://${app.name}.ocd.internal`);
  });
});


describe("injected environment ownership", () => {
  test("allows unchanged managed secrets while rejecting edits, deletion and duplicate keys", async () => {
    const stored = await processIncomingEnvVars([{ key: "DB_DSN", value: "private", secret: true }]);
    stored.entries[0].injected_by = "database";
    const response = maskEnvVarsForResponse(stored)[0];
    expect(response.injected_by).toBe("database");
    expect(response.value).toBe("••••••••");
    expect(response.encrypted_value).toBeUndefined();
    expect(response.iv).toBeUndefined();
    const row = { key: "DB_DSN", value: "••••••••", secret: true };
    expect((await mergeEnvVarUpdate(stored, [row])).entries).toEqual(stored.entries);
    for (const input of [[], [row, row], [{ ...row, value: "changed" }], [{ ...row, secret: false }]]) {
      await expect(mergeEnvVarUpdate(stored, input)).rejects.toThrow("injected");
    }
  });

  test("all environment writers protect injected entries; the injector can refresh them", () => {
    const entry = { key: "API_URL", value: "http://api.ocd.internal", secret: false, updated_at: "now", injected_by: "api" };
    const env = db.insertEnvironment(`managed-${randomSuffix()}`, serializeEnvVars([entry]));
    db.updateEnvironment(env.id, env.name, serializeEnvVars([entry, { key: "MODE", value: "debug", secret: false, updated_at: "now" }]));
    expect(() => db.updateEnvironment(env.id, env.name, serializeEnvVars([]))).toThrow("read-only");
    expect(() => db.updateEnvironment(env.id, env.name, serializeEnvVars([{ ...entry, value: "override" }]))).toThrow("read-only");
    db.updateEnvironment(env.id, env.name, serializeEnvVars([{ ...entry, value: "http://new.ocd.internal" }]), { injection: true });
    expect(parseEnvVars(db.getEnvironment(env.id)!.env_vars).entries[0].value).toBe("http://new.ocd.internal");
  });
});
