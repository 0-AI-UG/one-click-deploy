import { afterEach, describe, expect, test } from "bun:test";
import { resolveDockerfilePath, resolveManifestBuildPaths } from "./commands/deploy.ts";
import { assertLocalBuildPaths, resolveAuthPassword } from "./manifest.ts";

const AUTH_ENV = "OCD_TEST_MANIFEST_AUTH_PASSWORD";

afterEach(() => {
  delete process.env[AUTH_ENV];
});

describe("resolveAuthPassword", () => {
  test("uses a local environment variable without storing plaintext in the manifest", async () => {
    process.env[AUTH_ENV] = "correct horse battery staple";

    await expect(
      resolveAuthPassword({ enabled: true, password_env: AUTH_ENV }),
    ).resolves.toBe("correct horse battery staple");
  });

  test("returns the wire protocol's explicit clear value when auth is disabled", async () => {
    await expect(resolveAuthPassword({ enabled: false })).resolves.toBe("");
  });
});

describe("resolveDockerfilePath", () => {
  test("keeps root-context Dockerfiles repository-relative", () => {
    expect(resolveDockerfilePath(".", "Dockerfile")).toBe("Dockerfile");
  });

  test("resolves Dockerfiles relative to a nested build context", () => {
    expect(resolveDockerfilePath("zero-agent-website", "Dockerfile"))
      .toBe("zero-agent-website/Dockerfile");
  });
});

describe("local build preflight", () => {
  test("accepts canonical files/directories and rejects a missing Dockerfile", () => {
    expect(() => assertLocalBuildPaths("package.json", ".")).not.toThrow();
    expect(() => assertLocalBuildPaths("definitely-missing.Dockerfile", "."))
      .toThrow("Preflight failed: Dockerfile does not exist");
  });
});

describe("resolveManifestBuildPaths", () => {
  test("keeps standalone member paths relative to the member manifest", () => {
    expect(resolveManifestBuildPaths("services/worker", ".", "Dockerfile")).toEqual({
      context: "services/worker",
      dockerfile: "services/worker/Dockerfile",
    });
  });

  test("resolves nested context and Dockerfile from the manifest directory", () => {
    expect(resolveManifestBuildPaths("apps/admin", "frontend", "docker/Dockerfile")).toEqual({
      context: "apps/admin/frontend",
      dockerfile: "apps/admin/docker/Dockerfile",
    });
  });
});
