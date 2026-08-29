import { afterEach, describe, expect, test } from "bun:test";
import { loadAutoDeployConfig } from "./auto-deploy.ts";

const image = `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`;
const previous = process.env.HETZNER_API_TOKEN;

afterEach(() => {
  if (previous === undefined) delete process.env.HETZNER_API_TOKEN;
  else process.env.HETZNER_API_TOKEN = previous;
});

describe("auto-deploy config", () => {
  test("loads the provider credential from the environment", () => {
    process.env.HETZNER_API_TOKEN = "token-from-env";
    expect(loadAutoDeployConfig(JSON.stringify({ panel_image_ref: image }))).toMatchObject({
      panel_image_ref: image,
      hetzner_api_token: "token-from-env",
    });
  });

  test("supports an explicit secret environment variable name", () => {
    process.env.OCD_TEST_PROVIDER_TOKEN = "custom-token";
    try {
      expect(loadAutoDeployConfig(JSON.stringify({
        panel_image_ref: image,
        hetzner_api_token_env: "OCD_TEST_PROVIDER_TOKEN",
      })).hetzner_api_token).toBe("custom-token");
    } finally {
      delete process.env.OCD_TEST_PROVIDER_TOKEN;
    }
  });
});
