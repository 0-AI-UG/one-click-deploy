import { useTempDataDir, TEST_ADMIN_ID, seedTestAdmin } from "../../shared/test-helpers.ts";
useTempDataDir();
seedTestAdmin();

import { describe, test, expect, mock } from "bun:test";

// Bypass auth for all tests.
// Bypass the auth half of the permission layer, but spread the real module
// through so the scope helpers (appScope/stackScope/...) stay real — replacing
// it wholesale would hand routes `undefined` for those.
const realPermissions = await import("../lib/permissions.ts");
mock.module("../lib/permissions.ts", () => ({
  ...realPermissions,
  requireAdmin: async () => ({ userId: TEST_ADMIN_ID, username: "admin" }),
  requirePermission: async () => ({ userId: TEST_ADMIN_ID, username: "admin" }),
  requireAuthenticated: async () => ({ userId: TEST_ADMIN_ID, username: "admin" }),
}));

// The ingress endpoint re-syncs Traefik; stub it out (no live proxy in tests).
const syncCalls: number[] = [];
mock.module("../../engine/scale/traefik-manager.ts", () => ({
  syncAppIngress: async (appId: number) => { syncCalls.push(appId); },
  getPanelIngressIpv4: () => "203.0.113.9",
}));

import * as db from "../../shared/db.ts";
import { handleGetApps, handleUpdateIngressSettings } from "./apps.ts";

function makeApp(overrides: Partial<Parameters<typeof db.insertApp>[0]> = {}) {
  return db.insertApp({
    name: `app-${Math.random().toString(36).slice(2, 8)}`,
    domain: "gated.example.com",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    health_check: true,
    ...overrides,
  });
}

const ingressReq = (appId: number, body: unknown) =>
  handleUpdateIngressSettings(
    new Request(`http://x/api/apps/${appId}/ingress`, { method: "PUT", body: JSON.stringify(body) }),
    appId,
  );

describe("app response scrubbing", () => {
  test("secrets never leave the server; auth_enabled is derived", async () => {
    const app = makeApp({ auth_password: "hunter2" });
    // Populate the other secret-bearing columns so we can assert they're stripped.
    db.updateAppWebhook(app.id, true, "whsec_shhh", "main", "gh-1");
    db.updateAppSleepingState(app.id, 1, 10001);

    const res = await handleGetApps(new Request("http://x/api/apps"));
    const apps = (await res.json()) as Array<Record<string, unknown>>;
    const row = apps.find((a) => a.id === app.id)!;
    expect(row).toBeTruthy();

    // No credential fields.
    expect(row).not.toHaveProperty("auth_password");
    expect(row).not.toHaveProperty("auth_password_hash");
    expect(row).not.toHaveProperty("wake_token");
    expect(row).not.toHaveProperty("webhook_secret");
    // env_vars is scrubbed to an empty array.
    expect(row.env_vars).toEqual([]);
    // Derived boolean flag, true because a password is set.
    expect(row.auth_enabled).toBe(true);

    const open = makeApp();
    const res2 = await handleGetApps(new Request("http://x/api/apps"));
    const openRow = ((await res2.json()) as Array<Record<string, unknown>>).find((a) => a.id === open.id)!;
    expect(openRow.auth_enabled).toBe(false);
  });
});

describe("ingress endpoint: password set/clear", () => {
  test("setting a password stores only the hash and enables auth", async () => {
    const app = makeApp();
    const res = await ingressReq(app.id, { auth_password: "s3cret" });
    expect(res.status).toBe(200);

    const row = db.getApp(app.id)!;
    expect(row.auth_password_hash).not.toBe("");
    expect(Bun.password.verifySync("s3cret", row.auth_password_hash)).toBe(true);
    // No plaintext column exists anymore.
    expect(row).not.toHaveProperty("auth_password");
  });

  test("empty password clears the hash (disables auth)", async () => {
    const app = makeApp({ auth_password: "hunter2" });
    expect(db.getApp(app.id)!.auth_password_hash).not.toBe("");

    const res = await ingressReq(app.id, { auth_password: "" });
    expect(res.status).toBe(200);
    expect(db.getApp(app.id)!.auth_password_hash).toBe("");
  });

  test("omitting auth_password leaves the current password untouched", async () => {
    const app = makeApp({ auth_password: "hunter2" });
    const before = db.getApp(app.id)!.auth_password_hash;
    const res = await ingressReq(app.id, { rate_limit_rps: 5 });
    expect(res.status).toBe(200);
    expect(db.getApp(app.id)!.auth_password_hash).toBe(before);
  });

  test("rejects a password on a raw-TCP-routed app (internal_protocol tcp), same rule as deploy", async () => {
    const app = makeApp({ internal_protocol: "tcp" });
    const res = await ingressReq(app.id, { auth_password: "s3cret" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/requires HTTP internal routing/i);
    expect(db.getApp(app.id)!.auth_password_hash).toBe("");
  });

  test("rejects a password when switching an app to internal_protocol tcp in the same request", async () => {
    const app = makeApp();
    const res = await ingressReq(app.id, { internal_protocol: "tcp", auth_password: "s3cret" });
    expect(res.status).toBe(400);
    expect(db.getApp(app.id)!.auth_password_hash).toBe("");
  });

  test("persists internal_protocol changes and re-syncs ingress", async () => {
    const app = makeApp();
    expect(db.getApp(app.id)!.internal_protocol).toBe("http");
    const res = await ingressReq(app.id, { internal_protocol: "tcp" });
    expect(res.status).toBe(200);
    expect(db.getApp(app.id)!.internal_protocol).toBe("tcp");
  });
});
