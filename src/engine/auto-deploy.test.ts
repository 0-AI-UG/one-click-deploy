import { afterEach, describe, expect, test } from "bun:test";
import { loadAutoDeployConfig } from "./auto-deploy.ts";

const image = `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`;
const previous = process.env.OCD_PROVISIONER_TOKEN;

afterEach(() => {
  if (previous === undefined) delete process.env.OCD_PROVISIONER_TOKEN;
  else process.env.OCD_PROVISIONER_TOKEN = previous;
});

describe("auto-deploy config", () => {
  test("loads the provider credential from the environment", () => {
    process.env.OCD_PROVISIONER_TOKEN = "token-from-env";
    expect(loadAutoDeployConfig(JSON.stringify({ provisioner: "hetzner", panel_image_ref: image }))).toMatchObject({
      panel_image_ref: image,
      provisioner: "hetzner",
      provisioner_token: "token-from-env",
    });
  });

  test("supports an explicit secret environment variable name", () => {
    process.env.OCD_TEST_PROVIDER_TOKEN = "custom-token";
    try {
      expect(loadAutoDeployConfig(JSON.stringify({
        panel_image_ref: image,
        provisioner: "hetzner",
        provisioner_token_env: "OCD_TEST_PROVIDER_TOKEN",
      })).provisioner_token).toBe("custom-token");
    } finally {
      delete process.env.OCD_TEST_PROVIDER_TOKEN;
    }
  });

  test("accepts an operator-owned host without a provider credential", () => {
    expect(loadAutoDeployConfig(JSON.stringify({
      panel_image_ref: image,
      connected_host: {
        name: "panel-1",
        management_address: "203.0.113.10",
        routing_address: "10.0.0.10",
        ssh_host_key: `203.0.113.10 ssh-ed25519 ${"A".repeat(48)}`,
        ssh_private_key: "/keys/id_ed25519",
      },
    }))).toMatchObject({
      panel_image_ref: image,
      connected_host: { name: "panel-1", routing_address: "10.0.0.10" },
    });
  });

  test("rejects ambiguous provider and connected-host configuration", () => {
    process.env.OCD_PROVISIONER_TOKEN = "token-from-env";
    expect(() => loadAutoDeployConfig(JSON.stringify({
      panel_image_ref: image,
      provisioner: "hetzner",
      connected_host: {
        name: "panel-1",
        management_address: "203.0.113.10",
        routing_address: "10.0.0.10",
        ssh_host_key: `203.0.113.10 ssh-ed25519 ${"A".repeat(48)}`,
        ssh_private_key: "/keys/id_ed25519",
      },
    }))).toThrow(/exactly one/);
  });
});
