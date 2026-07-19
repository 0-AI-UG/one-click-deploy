import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "./db.ts";
import { platformEnvVars, resolveAppEnvVars, serializeEnvVars } from "./env-crypto.ts";

describe("platformEnvVars", () => {
  test("HTTP-routed app (internal_protocol=http) gets a port-less http:// internal URL", () => {
    const vars = platformEnvVars({ name: "api", internal_protocol: "http", container_port: 3000 });
    expect(vars).toEqual({
      OCD_INTERNAL_URL: "http://api.ocd.internal",
      OCD_INTERNAL_HOST: "api.ocd.internal",
      OCD_INTERNAL_PORT: "80",
    });
  });

  test("TCP-routed app (internal_protocol=tcp) gets a tcp:// URL on its container port", () => {
    const vars = platformEnvVars({ name: "queue", internal_protocol: "tcp", container_port: 5432 });
    expect(vars).toEqual({
      OCD_INTERNAL_URL: "tcp://queue.ocd.internal:5432",
      OCD_INTERNAL_HOST: "queue.ocd.internal",
      OCD_INTERNAL_PORT: "5432",
    });
  });
});

describe("resolveAppEnvVars platform injection", () => {
  function makeApp(opts: { environment_id?: number; health_check?: boolean; internal_protocol?: "http" | "tcp" } = {}) {
    const name = `envtest-${randomSuffix()}`;
    return db.insertApp({
      name,
      domain: `${name}.example.com`,
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
      environment_id: opts.environment_id,
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
});
