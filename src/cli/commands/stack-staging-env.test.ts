import { describe, expect, test } from "bun:test";
import { parseStagingEnvFlags } from "./stack.ts";

describe("parseStagingEnvFlags", () => {
  test("absent flag leaves the selection undefined (stored value preserved)", () => {
    const r = parseStagingEnvFlags([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stagingEnv).toBeUndefined();
  });

  test("a value selects the stack's staging environment", () => {
    const r = parseStagingEnvFlags(["staging"]);
    if (!r.ok) throw new Error(r.error);
    expect(r.stagingEnv).toBe("staging");
  });

  test("numeric id is kept verbatim for resolution", () => {
    const r = parseStagingEnvFlags(["7"]);
    if (!r.ok) throw new Error(r.error);
    expect(r.stagingEnv).toBe("7");
  });

  test("empty value explicitly clears the staging environment", () => {
    const r = parseStagingEnvFlags([""]);
    if (!r.ok) throw new Error(r.error);
    expect(r.stagingEnv).toBeNull();
  });

  test("values are trimmed", () => {
    const r = parseStagingEnvFlags([" staging "]);
    if (!r.ok) throw new Error(r.error);
    expect(r.stagingEnv).toBe("staging");
  });

  test("an <app>:<env> value is treated as a plain environment name", () => {
    const r = parseStagingEnvFlags(["api:staging"]);
    if (!r.ok) throw new Error(r.error);
    expect(r.stagingEnv).toBe("api:staging");
  });

  test("repeating the flag with the same value is fine", () => {
    const r = parseStagingEnvFlags(["staging", " staging "]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stagingEnv).toBe("staging");
  });

  test("conflicting values are an error", () => {
    const r = parseStagingEnvFlags(["staging", "other"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("more than once");
  });

  test("clearing and setting in the same invocation conflicts", () => {
    const r = parseStagingEnvFlags(["", "staging"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("(cleared)");
  });
});
