import { describe, expect, test } from "bun:test";
import { resolveRuntimeEnv, serializeRuntimeConfig, affectedAppsForEnvironmentKeys, type RuntimeApp, type RuntimeConfig } from "./runtime-env.ts";
const app = (name: string, config: Partial<RuntimeConfig>, environment_id: number | null = 1): RuntimeApp => ({
  name, container_port: 5432, internal_protocol: "tcp", environment_id, stack_id: 1, env_vars: serializeRuntimeConfig(config),
});
const database = app("demo-db", {
  env: { PASSWORD: { from: "environment.DB_PASSWORD" }, USER: "service" },
  outputs: { URL: { template: "postgres://{env.USER}:{env.PASSWORD}@{app.host}:{app.port}/main", secret: true } },
});
const api = app("demo-api", { env: { DATABASE_URL: { from: "apps.db.outputs.URL" }, MODE: "production" } });
const worker = app("demo-worker", {
  env: { DATABASE_URL: { from: "apps.api.outputs.DATABASE" } },
});
const ctx = (apps: RuntimeApp[]) => ({ apps, stackNames: { 1: "demo" }, environment: () => ({ DB_PASSWORD: "secret$&", UNRELATED: "hidden" }) });

describe("explicit runtime environment resolution", () => {
  test("resolves cross-app output templates without exposing unrelated environment values", async () => {
    expect(await resolveRuntimeEnv(api, ctx([database, api]))).toEqual({
      DATABASE_URL: "postgres://service:secret$&@demo-db.ocd.internal:5432/main", MODE: "production",
    });
  });
  test("substituted values remain literal even when they contain template tokens", async () => {
    expect((await resolveRuntimeEnv(api, {...ctx([database,api]), environment:()=>({DB_PASSWORD:"{app.host}"})})).DATABASE_URL)
      .toBe("postgres://service:{app.host}@demo-db.ocd.internal:5432/main");
  });
  test("rejects values that could inject additional lines into the container env file", async () => {
    await expect(resolveRuntimeEnv(api, {...ctx([database,api]), environment:()=>({DB_PASSWORD:"safe\nUNDECLARED=injected"})})).rejects.toThrow("newline or NUL");
  });
  test("empty maps inject no shared values, even when an environment is selected", async () => {
    expect(await resolveRuntimeEnv(app("demo-empty", {}), ctx([]))).toEqual({});
  });
  test("missing references fail without returning partial values", async () => {
    await expect(resolveRuntimeEnv(app("demo-api", { env: { TOKEN: {from:"environment.MISSING"} } }), ctx([]))).rejects.toThrow("Missing environment variable MISSING");
    await expect(resolveRuntimeEnv(api, ctx([]))).rejects.toThrow("Missing stack member db");
    await expect(resolveRuntimeEnv(app("demo-empty", { env: { TOKEN: {from:"environment.DB_PASSWORD"} } }, null), ctx([]))).rejects.toThrow("none is selected");
  });
  test("cycles through outputs fail with an actionable path", async () => {
    const a = app("demo-a", { env: { URL: {from:"apps.b.outputs.URL"} }, outputs: { URL: {template:"{env.URL}"} } });
    const b = app("demo-b", { env: { URL: {from:"apps.a.outputs.URL"} }, outputs: { URL: {template:"{env.URL}"} } });
    await expect(resolveRuntimeEnv(a, ctx([a,b]))).rejects.toThrow("Runtime reference cycle");
  });
  test("same member names in other stacks never satisfy a reference", async () => {
    await expect(resolveRuntimeEnv(api, ctx([{...database, stack_id:2}, api]))).rejects.toThrow("Missing stack member db");
  });
  test("changed environment keys propagate transitively through referenced outputs", () => {
    const exportingApi = {...api, env_vars: serializeRuntimeConfig({env:{DATABASE_URL:{from:"apps.db.outputs.URL"}},outputs:{DATABASE:{template:"{env.DATABASE_URL}"}}})};
    const apps = [database, exportingApi, worker, app("demo-isolated",{env:{MODE:"production"}})];
    expect(affectedAppsForEnvironmentKeys(apps,1,["DB_PASSWORD"],{1:"demo"}).map(a=>a.name)).toEqual(["demo-db","demo-api","demo-worker"]);
    expect(affectedAppsForEnvironmentKeys(apps,1,["UNRELATED"],{1:"demo"})).toEqual([]);
  });
});
