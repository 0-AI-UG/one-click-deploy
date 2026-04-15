import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const verifyToken = mock(async (_token: string) => {});
const listServerTypes = mock(async () => [
  { name: "cx22", description: "2 vCPU", cores: 2, memory: 4, disk: 40, locations: ["fsn1"] },
]);
const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  tokenKey: "hetzner_api_token",
  validateToken: (tok: string) => {
    if (!tok || tok.length < 32) return { valid: false, error: "too short" };
    if (!/^[\x20-\x7e]+$/.test(tok)) return { valid: false, error: "bad chars" };
    return { valid: true, value: tok };
  },
  verifyToken,
  listServerTypes,
  ensureSshKey: async () => ({ id: "", name: "" }),
  ensureFirewall: async () => "",
  createServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "" }),
  getServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "" }),
  waitForRunning: async () => {},
  deleteServer: async () => {},
  listServers: async () => [],
};
mock.module("../../shared/providers/index.ts", () => ({
  getComputeProvider: () => fakeProvider,
  getDnsProvider: () => ({ id: "", name: "", listZones: async () => [], createRecord: async () => ({}), deleteRecord: async () => {} }),
}));

mock.module("../lib/auth.ts", () => ({
  createTempToken: async (userId: string) => `temp.${userId}`,
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  handleSetupStatus,
  handleSetupServerTypes,
  handleSetupComplete,
  isSetupComplete,
} from "./setup.ts";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function wipeUsers() {
  for (const u of db.getUsers()) db.deleteUser(u.id);
}

beforeEach(async () => {
  wipeUsers();
  await secretStore.delete("hetzner_api_token");
  verifyToken.mockClear();
  listServerTypes.mockClear();
  verifyToken.mockImplementation(async () => {});
});

describe("isSetupComplete / handleSetupStatus", () => {
  test("initial state: setup not complete, no token", async () => {
    expect(isSetupComplete()).toBe(false);
    const r = await handleSetupStatus(new Request("http://localhost/setup"));
    const body = (await r.json()) as { setupComplete: boolean; hasProviderToken: boolean };
    expect(body.setupComplete).toBe(false);
    expect(body.hasProviderToken).toBe(false);
  });

  test("reports hasProviderToken=true when token is persisted (handoff case)", async () => {
    await secretStore.set("hetzner_api_token", "h".repeat(40));
    const r = await handleSetupStatus(new Request("http://localhost/setup"));
    const body = (await r.json()) as { hasProviderToken: boolean };
    expect(body.hasProviderToken).toBe(true);
  });

  test("setupComplete flips true once an admin user exists", async () => {
    db.insertUser({
      id: crypto.randomUUID(),
      username: "admin",
      password_hash: "x",
      is_admin: true,
    });
    expect(isSetupComplete()).toBe(true);
  });
});

describe("handleSetupServerTypes", () => {
  test("rejects with 400 once setup is complete", async () => {
    db.insertUser({ id: "u1", username: "a", password_hash: "x", is_admin: true });
    const r = await handleSetupServerTypes(jsonReq({ provider_token: "x".repeat(40) }));
    expect(r.status).toBe(400);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test("empty token returns empty server_types without calling provider", async () => {
    const r = await handleSetupServerTypes(jsonReq({ provider_token: "" }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { server_types: unknown[] };
    expect(body.server_types).toEqual([]);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(listServerTypes).not.toHaveBeenCalled();
  });

  test("malformed token short-circuits before hitting verifyToken", async () => {
    const r = await handleSetupServerTypes(jsonReq({ provider_token: "short" }));
    expect(r.status).toBe(400);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  test("verifyToken failure is surfaced as 400 with provider message", async () => {
    verifyToken.mockImplementationOnce(async () => { throw new Error("invalid api key"); });
    const r = await handleSetupServerTypes(jsonReq({ provider_token: "x".repeat(40) }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid api key");
    // Token must NOT have been persisted.
    expect(await secretStore.get("hetzner_api_token")).toBeNull();
  });

  test("valid token persists and returns server types", async () => {
    const tok = "x".repeat(40);
    const r = await handleSetupServerTypes(jsonReq({ provider_token: tok }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { server_types: Array<{ name: string }> };
    expect(body.server_types.map((t) => t.name)).toContain("cx22");
    expect(await secretStore.get("hetzner_api_token")).toBe(tok);
  });
});

describe("handleSetupComplete", () => {
  test("rejects with 400 once an admin exists", async () => {
    db.insertUser({ id: "u1", username: "a", password_hash: "x", is_admin: true });
    const r = await handleSetupComplete(jsonReq({ username: "b", password: "pw" }));
    expect(r.status).toBe(400);
  });

  test("requires both username and password", async () => {
    let r = await handleSetupComplete(jsonReq({ username: "a" }));
    expect(r.status).toBe(400);
    r = await handleSetupComplete(jsonReq({ password: "p" }));
    expect(r.status).toBe(400);
  });

  test("requires either a new token or an existing one", async () => {
    const r = await handleSetupComplete(jsonReq({ username: "a", password: "pw" }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/token/i);
  });

  test("rejects an invalid new token shape", async () => {
    const r = await handleSetupComplete(
      jsonReq({ username: "a", password: "pw", provider_token: "short" }),
    );
    expect(r.status).toBe(400);
    expect(db.getUsers().length).toBe(0);
  });

  test("creates admin + persists token, DNS, server-type, location on success", async () => {
    const tok = "z".repeat(40);
    const r = await handleSetupComplete(
      jsonReq({
        username: "admin",
        password: "correct-horse",
        provider_token: tok,
        dns_zone_id: "zone-abc",
        default_server_type: "cx22",
        default_location: "fsn1",
      }),
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { tempToken: string; user: { username: string } };
    expect(body.tempToken).toMatch(/^temp\./);
    expect(body.user.username).toBe("admin");

    const users = db.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].is_admin).toBeTruthy();
    expect(await secretStore.get("hetzner_api_token")).toBe(tok);
    const settings = db.getSettings();
    expect(settings.dns_zone_id).toBe("zone-abc");
    expect(settings.default_server_type).toBe("cx22");
    expect(settings.default_location).toBe("fsn1");
  });

  test("accepts the handoff flow: existing token + no new token", async () => {
    const existing = "h".repeat(40);
    await secretStore.set("hetzner_api_token", existing);
    const r = await handleSetupComplete(
      jsonReq({ username: "admin", password: "pw" }),
    );
    expect(r.status).toBe(201);
    // Token preserved, not overwritten.
    expect(await secretStore.get("hetzner_api_token")).toBe(existing);
  });

  test("stores a bcrypt-hashed password (never the plaintext)", async () => {
    await handleSetupComplete(
      jsonReq({
        username: "admin",
        password: "plaintext-secret",
        provider_token: "p".repeat(40),
      }),
    );
    const u = db.getUserByUsername("admin");
    expect(u).not.toBeNull();
    expect(u!.password_hash).not.toBe("plaintext-secret");
    expect(u!.password_hash.startsWith("$2")).toBe(true);
    expect(await Bun.password.verify("plaintext-secret", u!.password_hash)).toBe(true);
  });
});
