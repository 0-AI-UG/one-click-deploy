import { afterEach, describe, expect, test } from "bun:test";
import { resolveAuthPassword } from "./manifest.ts";

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
