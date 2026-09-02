import { describe, expect, test } from "bun:test";
import { managedRuntimeImageMarker, managedRuntimeImageTag } from "./build.ts";

const digest = "0123456789abcdef".repeat(4);

describe("managedRuntimeImageTag", () => {
  test("creates an ownership-only local tag from an immutable digest", () => {
    expect(managedRuntimeImageTag("api", `ghcr.io/acme/api@sha256:${digest}`)).toBe(
      `ocd-managed/api:${digest}`,
    );
    expect(managedRuntimeImageMarker(`ghcr.io/acme/api@sha256:${digest}`)).toBe(
      `/home/deploy/.ocd-image-pulls/${digest}`,
    );
  });

  test("rejects mutable images and unsafe app names", () => {
    expect(() => managedRuntimeImageTag("api", "ghcr.io/acme/api:latest")).toThrow();
    expect(() => managedRuntimeImageMarker("ghcr.io/acme/api:latest")).toThrow();
    expect(() => managedRuntimeImageTag("api;rm", `ghcr.io/acme/api@sha256:${digest}`)).toThrow();
  });
});
