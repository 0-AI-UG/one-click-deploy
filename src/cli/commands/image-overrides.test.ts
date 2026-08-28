import { describe, expect, test } from "bun:test";
import { validateImageOverride } from "./deploy.ts";
import { parseStackImageOverrides } from "./stack.ts";

const WEB = `ghcr.io/acme/web@sha256:${"a".repeat(64)}`;
const WORKER = `ghcr.io/acme/worker@sha256:${"b".repeat(64)}`;

describe("CI image overrides", () => {
  test("accepts one exact digest without mutating a manifest file", () => {
    expect(validateImageOverride(`  ${WEB}  `)).toBe(WEB);
  });

  test("maps repeatable stack member overrides", () => {
    expect(parseStackImageOverrides(
      [`web=${WEB}`, `worker=${WORKER}`],
      new Set(["web", "worker"]),
    )).toEqual(new Map([["web", WEB], ["worker", WORKER]]));
  });

  test("rejects mutable, unknown, and duplicate stack overrides", () => {
    expect(() => validateImageOverride("ghcr.io/acme/web:latest")).toThrow(/immutable/);
    expect(() => parseStackImageOverrides([`api=${WEB}`], new Set(["web"]))).toThrow(/Unknown stack member/);
    expect(() => parseStackImageOverrides([`web=${WEB}`, `web=${WEB}`], new Set(["web"]))).toThrow(/Duplicate/);
  });
});
