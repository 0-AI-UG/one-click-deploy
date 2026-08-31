import { describe, expect, test } from "bun:test";
import { parseOciImage, resolveOciImage } from "./oci-image.ts";

describe("OCI image intent", () => {
  test("normalizes Docker Hub shorthand", () => {
    expect(parseOciImage("postgres:17-alpine")).toMatchObject({
      registry: "docker.io",
      apiRegistry: "registry-1.docker.io",
      repository: "library/postgres",
      reference: "17-alpine",
      canonicalRepository: "docker.io/library/postgres",
    });
  });

  test("keeps an immutable digest without a registry request", async () => {
    const digest = "a".repeat(64);
    expect(await resolveOciImage(`ghcr.io/acme/app@sha256:${digest}`))
      .toBe(`ghcr.io/acme/app@sha256:${digest}`);
  });

  test("rejects malformed image names", () => {
    expect(() => parseOciImage("postgres image:17")).toThrow("Invalid OCI image reference");
  });
});
