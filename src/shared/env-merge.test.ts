import { describe, test, expect } from "bun:test";
import { mergeEnv, type AppEnvDefs } from "./env-merge.ts";

const app = (name: string, defs: AppEnvDefs["defs"]): AppEnvDefs => ({ app: name, defs });

describe("mergeEnv — single app (a stack of one)", () => {
  test("generates secrets once and preserves an existing value", () => {
    const first = mergeEnv([app("db", [{ key: "PASSWORD", generate: "password", secret: true }])]);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].value).toHaveLength(32);
    expect(first.entries[0].secret).toBe(true);
    expect(mergeEnv(
      [app("db", [{ key: "PASSWORD", generate: "password", secret: true }])],
      {},
      new Set(["PASSWORD"]),
    ).entries).toEqual([]);
  });

  test("emits a manifest default", () => {
    const r = mergeEnv([app("web", [{ key: "PORT", default: "3000" }])]);
    expect(r.entries).toEqual([{ key: "PORT", value: "3000", secret: false }]);
    expect(r.conflicts).toEqual([]);
    expect(r.requiredMissing).toEqual([]);
  });

  test("required with no default surfaces as requiredMissing, not an entry", () => {
    const r = mergeEnv([app("web", [{ key: "API_KEY", required: true, secret: true }])]);
    expect(r.entries).toEqual([]);
    expect(r.requiredMissing).toEqual([{ key: "API_KEY", apps: ["web"], secret: true, description: undefined }]);
  });

  test("--set overrides a manifest default", () => {
    const r = mergeEnv([app("web", [{ key: "PORT", default: "3000" }])], { PORT: "8080" });
    expect(r.entries).toEqual([{ key: "PORT", value: "8080", secret: false }]);
  });

  test("existing env var wins over the manifest default and is not re-emitted", () => {
    const r = mergeEnv([app("web", [{ key: "PORT", default: "3000" }])], {}, new Set(["PORT"]));
    expect(r.entries).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  test("--set overrides even an existing env var", () => {
    const r = mergeEnv([app("web", [{ key: "PORT", default: "3000" }])], { PORT: "8080" }, new Set(["PORT"]));
    expect(r.entries).toEqual([{ key: "PORT", value: "8080", secret: false }]);
  });
});

describe("mergeEnv — multiple apps sharing one environment", () => {
  test("matching defaults collapse to one entry", () => {
    const r = mergeEnv([
      app("web", [{ key: "REGION", default: "eu" }]),
      app("api", [{ key: "REGION", default: "eu" }]),
    ]);
    expect(r.entries).toEqual([{ key: "REGION", value: "eu", secret: false }]);
    expect(r.conflicts).toEqual([]);
  });

  test("one app has no default → take the other's", () => {
    const r = mergeEnv([
      app("web", [{ key: "REGION", required: true }]),
      app("api", [{ key: "REGION", default: "eu" }]),
    ]);
    expect(r.entries).toEqual([{ key: "REGION", value: "eu", secret: false }]);
    expect(r.requiredMissing).toEqual([]);
  });

  test("differing defaults → conflict, no entry", () => {
    const r = mergeEnv([
      app("web", [{ key: "REGION", default: "eu" }]),
      app("api", [{ key: "REGION", default: "us" }]),
    ]);
    expect(r.entries).toEqual([]);
    expect(r.conflicts).toEqual([{ key: "REGION", apps: ["web", "api"], values: ["eu", "us"] }]);
  });

  test("--set resolves a differing-defaults conflict", () => {
    const r = mergeEnv(
      [app("web", [{ key: "REGION", default: "eu" }]), app("api", [{ key: "REGION", default: "us" }])],
      { REGION: "ap" },
    );
    expect(r.entries).toEqual([{ key: "REGION", value: "ap", secret: false }]);
    expect(r.conflicts).toEqual([]);
  });

  test("an existing env var resolves a differing-defaults conflict", () => {
    const r = mergeEnv(
      [app("web", [{ key: "REGION", default: "eu" }]), app("api", [{ key: "REGION", default: "us" }])],
      {},
      new Set(["REGION"]),
    );
    expect(r.entries).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  test("secret flag is sticky if any declaring app marks it secret", () => {
    const r = mergeEnv([
      app("web", [{ key: "TOKEN", default: "x" }]),
      app("api", [{ key: "TOKEN", default: "x", secret: true }]),
    ]);
    expect(r.entries).toEqual([{ key: "TOKEN", value: "x", secret: true }]);
  });
});
