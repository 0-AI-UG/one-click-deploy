import { useTempDataDir, seedTestAdmin, configureTestInfrastructureProvider } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Bypass auth for all tests.
// Bypass the auth half of the permission layer, but spread the real module
// through so the scope helpers (appScope/stackScope/...) stay real — replacing
// it wholesale would hand routes `undefined` for those.
const realPermissions = await import("../lib/permissions.ts");
mock.module("../lib/permissions.ts", () => ({
  ...realPermissions,
  // seedTestAdmin() is idempotent and runs per request, not at module load:
  // three other suites wipe the whole `users` table, and the row has to exist
  // at the moment a handler calls hasPermission — file order is not ours.
  requireAdmin: async () => ({ userId: seedTestAdmin(), username: "admin" }),
  requirePermission: async () => ({ userId: seedTestAdmin(), username: "admin" }),
  requireAuthenticated: async () => ({ userId: seedTestAdmin(), username: "admin" }),
}));

const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  capabilities: { compute: true, volumes: true, privateNetwork: true, firewall: true },
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
  ensureFirewallAttached: async () => {},
  createServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  getServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  waitForRunning: async () => {},
  deleteServer: async () => {},
  listServers: async () => [],
};
mock.module("../../shared/providers/index.ts", () => ({
  hetzner: fakeProvider,
  getInfrastructureProvider: (id: string) => id === "hetzner" ? fakeProvider : undefined,
  listInfrastructureProviders: () => [fakeProvider],
}));
const realS3 = await import("../../engine/object-storage/s3.ts");
mock.module("../../engine/object-storage/s3.ts", () => ({
  ...realS3,
  listBuckets: async () => [],
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { __replaceInfrastructureProvidersForTest } from "../../shared/providers/registry.ts";
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
  __replaceInfrastructureProvidersForTest([fakeProvider as any]);
  configureTestInfrastructureProvider("hetzner");
  await secretStore.delete("provider.hetzner-test.api_token");
  await secretStore.delete("github_oauth_client_secret");
  await secretStore.delete("oci_registry_password");
});

describe("handleGetSettings", () => {
  test("masks github_oauth_client_secret", async () => {
    await secretStore.set("github_oauth_client_secret", "oauth-secret-abc123456789-zzz");
    const r = await handleGetSettings(req());
    const body = (await r.json()) as { github_oauth_client_secret: string };
    expect(body.github_oauth_client_secret).not.toContain("abc123");
    expect(body.github_oauth_client_secret).toMatch(/\.\.\./);
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
  test("stores an OCI repository allowlist and masks credentials", async () => {
    const r = await handleSaveSettings(req({
      oci_artifact_ref: "registry.example/ocd/artifacts",
      oci_registry_username: "deployer",
      oci_registry_password: "registry-secret-value",
    }));
    expect(r.status).toBe(200);
    expect(db.getSettings().oci_artifact_ref).toBe("registry.example/ocd/artifacts");
    expect(await secretStore.get("oci_registry_password")).toBe("registry-secret-value");
    const shown = await (await handleGetSettings(req())).json() as Record<string, unknown>;
    expect(shown.oci_registry_password).not.toBe("registry-secret-value");
  });

  test("rejects invalid OCI repository defaults", async () => {
    const r = await handleSaveSettings(req({ oci_artifact_ref: "not-a-repository" }));
    expect(r.status).toBe(400);
  });

  test("saves the provider-neutral default domain suffix and server defaults", async () => {
    const r = await handleSaveSettings(
      req({
        default_domain_suffix: "apps.example.org",
        default_server_type: "cx22",
        default_location: "fsn1",
      }),
    );
    expect(r.status).toBe(200);
    const s = db.getSettings();
    expect(s.default_domain_suffix).toBe("apps.example.org");
    expect(s.default_server_type).toBe("cx22");
    expect(s.default_location).toBe("fsn1");
  });

  test("rejects invalid default domain suffixes", async () => {
    const r = await handleSaveSettings(req({ default_domain_suffix: "https://bad.example/path" }));
    expect(r.status).toBe(400);
  });

  test("rejects removed provider and DNS settings instead of persisting them", async () => {
    for (const key of ["provider_token", "compute_provider", "dns_provider", "dns_zone_id", "dns_zone_name", "infrastructure_provisioner", "infrastructure_token", "object_storage_access_key"]) {
      const r = await handleSaveSettings(req({ [key]: "legacy-value" }));
      expect(r.status).toBe(400);
      expect(db.getSettings()[key]).toBeUndefined();
    }
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
    await secretStore.set("provider.hetzner-test.api_token", "x".repeat(40));
    const r = await handleGetServerTypes(req());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { server_types: Array<{ name: string }> };
    expect(body.server_types.map((t) => t.name)).toContain("cx22");
  });

  test("returns an empty provider-neutral result when Hetzner is not configured", async () => {
    const r = await handleGetServerTypes(req());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ server_types: [] });
  });
});
