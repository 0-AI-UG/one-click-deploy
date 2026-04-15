import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Bypass auth for all tests.
mock.module("../lib/permissions.ts", () => ({
  requireAdmin: async () => ({ userId: "admin", username: "admin" }),
  requirePermission: async () => ({ userId: "admin", username: "admin" }),
}));

const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  tokenKey: "hetzner_api_token",
  validateToken: (tok: string) => {
    if (!tok || tok.length < 32) return { valid: false, error: "too short" };
    if (!/^[\x20-\x7e]+$/.test(tok)) return { valid: false, error: "bad chars" };
    return { valid: true, value: tok };
  },
  listServerTypes: async () => [
    { name: "cx22", description: "2 vCPU", cores: 2, memory: 4, disk: 40, locations: ["fsn1"] },
  ],
  verifyToken: async () => {},
  ensureSshKey: async () => ({ id: "k", name: "k" }),
  ensureFirewall: async () => "fw-1",
  createServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  getServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  waitForRunning: async () => {},
  deleteServer: async () => {},
  listServers: async () => [],
};
mock.module("../../shared/providers/index.ts", () => ({
  getComputeProvider: () => fakeProvider,
  getDnsProvider: () => ({ id: "", name: "", listZones: async () => [], createRecord: async () => ({}), deleteRecord: async () => {} }),
  listComputeProviders: () => [fakeProvider],
  listDnsProviders: () => [],
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  handleGetSettings,
  handleSaveSettings,
  handleGetServerTypes,
} from "./settings.ts";

function req(body?: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await secretStore.delete("hetzner_api_token");
  await secretStore.delete("github_oauth_client_secret");
});

describe("handleGetSettings", () => {
  test("returns masked provider token (never the raw value)", async () => {
    const token = "hetz-" + "x".repeat(40);
    await secretStore.set("hetzner_api_token", token);
    const r = await handleGetSettings(req());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { provider_token: string };
    expect(body.provider_token).not.toContain(token);
    expect(body.provider_token).toMatch(/\.\.\./);
    expect(body.provider_token.startsWith("hetz")).toBe(true);
  });

  test("returns empty string when no token has been set", async () => {
    const r = await handleGetSettings(req());
    const body = (await r.json()) as { provider_token: string };
    expect(body.provider_token).toBe("");
  });

  test("exposes provider metadata", async () => {
    const r = await handleGetSettings(req());
    const body = (await r.json()) as { provider: { id: string; name: string } };
    expect(body.provider).toMatchObject({ id: "hetzner", name: "Hetzner" });
  });

  test("masks github_oauth_client_secret", async () => {
    await secretStore.set("github_oauth_client_secret", "oauth-secret-abc123456789-zzz");
    const r = await handleGetSettings(req());
    const body = (await r.json()) as { github_oauth_client_secret: string };
    expect(body.github_oauth_client_secret).not.toContain("abc123");
    expect(body.github_oauth_client_secret).toMatch(/\.\.\./);
  });
});

describe("handleSaveSettings: provider_token", () => {
  test("rejects an invalid token shape without persisting", async () => {
    const r = await handleSaveSettings(req({ provider_token: "too-short" }));
    expect(r.status).toBe(400);
    expect(await secretStore.get("hetzner_api_token")).toBeNull();
  });

  test("persists a valid token", async () => {
    const tok = "a".repeat(40);
    const r = await handleSaveSettings(req({ provider_token: tok }));
    expect(r.status).toBe(200);
    expect(await secretStore.get("hetzner_api_token")).toBe(tok);
  });

  test("ignores a masked token (user re-submitting the GET payload)", async () => {
    const tok = "b".repeat(40);
    await secretStore.set("hetzner_api_token", tok);
    const r = await handleSaveSettings(req({ provider_token: "a123...zzzz" }));
    expect(r.status).toBe(200);
    // Original token must be preserved.
    expect(await secretStore.get("hetzner_api_token")).toBe(tok);
  });

  test("overwrites an existing token on a fresh valid value", async () => {
    await secretStore.set("hetzner_api_token", "c".repeat(40));
    const fresh = "d".repeat(40);
    await handleSaveSettings(req({ provider_token: fresh }));
    expect(await secretStore.get("hetzner_api_token")).toBe(fresh);
  });
});

describe("handleSaveSettings: github_oauth_client_secret", () => {
  test("persists a new secret", async () => {
    await handleSaveSettings(req({ github_oauth_client_secret: "gh-secret-aaa" }));
    expect(await secretStore.get("github_oauth_client_secret")).toBe("gh-secret-aaa");
  });

  test("empty value clears the secret", async () => {
    await secretStore.set("github_oauth_client_secret", "existing");
    await handleSaveSettings(req({ github_oauth_client_secret: "" }));
    expect(await secretStore.get("github_oauth_client_secret")).toBeNull();
  });

  test("masked re-submission is a no-op", async () => {
    await secretStore.set("github_oauth_client_secret", "keeper");
    await handleSaveSettings(req({ github_oauth_client_secret: "abc...xyz" }));
    expect(await secretStore.get("github_oauth_client_secret")).toBe("keeper");
  });
});

describe("handleSaveSettings: plain db settings", () => {
  test("saves dns_zone_id and default_server_type to the settings table", async () => {
    const r = await handleSaveSettings(
      req({
        dns_zone_id: "zone-abc",
        default_server_type: "cx22",
        default_location: "fsn1",
      }),
    );
    expect(r.status).toBe(200);
    const s = db.getSettings();
    expect(s.dns_zone_id).toBe("zone-abc");
    expect(s.default_server_type).toBe("cx22");
    expect(s.default_location).toBe("fsn1");
  });

  test("require_2fa is coerced to '1' / '0' string", async () => {
    await handleSaveSettings(req({ require_2fa: true }));
    expect(db.getSettings().require_2fa).toBe("1");
    await handleSaveSettings(req({ require_2fa: false }));
    expect(db.getSettings().require_2fa).toBe("0");
  });
});

describe("handleGetServerTypes", () => {
  test("returns the server types from the active compute provider", async () => {
    const r = await handleGetServerTypes(req());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { server_types: Array<{ name: string }> };
    expect(body.server_types.map((t) => t.name)).toContain("cx22");
  });
});
