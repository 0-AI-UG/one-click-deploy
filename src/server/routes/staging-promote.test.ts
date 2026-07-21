import { useTempDataDir, randomSuffix, seedTestAdmin } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";

// Bypass auth for all tests (same pattern as apps-auth.test.ts).
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

// apps.ts imports the Traefik manager at module load; stub it (no live proxy).
mock.module("../../engine/scale/traefik-manager.ts", () => ({
  syncAppIngress: async () => {},
  getPanelIngressIpv4: () => null,
}));

import * as db from "../../shared/db.ts";
import { handlePromoteApp, handleGetAppStaging } from "./apps.ts";
import { handleSetServerPool } from "./servers.ts";
import { deployToStaging } from "../lib/staging.ts";

function makeApp(overrides: Partial<Parameters<typeof db.insertApp>[0]> = {}) {
  return db.insertApp({
    name: `app-${randomSuffix()}`,
    domain: "",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    ...overrides,
  });
}

function makeEnv() {
  return db.insertEnvironment(`env-${randomSuffix()}`, "{}");
}

function makeServer() {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "9.9.9.9",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

const poolReq = (serverId: number, body: unknown) =>
  handleSetServerPool(
    new Request(`http://x/api/servers/${serverId}/pool`, { method: "PATCH", body: JSON.stringify(body) }),
    serverId,
  );

const promoteReq = (body: unknown) =>
  handlePromoteApp(new Request("http://x/api/apps/promote", { method: "POST", body: JSON.stringify(body) }));

const stagingReq = (appId: number) =>
  handleGetAppStaging(new Request(`http://x/api/apps/${appId}/staging`), appId);

describe("handleSetServerPool", () => {
  test("accepts 'general' and 'staging' and persists the pool", async () => {
    const server = makeServer();

    let res = await poolReq(server.id, { pool: "staging" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "staging" });
    expect((db.getServer(server.id) as any).pool).toBe("staging");

    res = await poolReq(server.id, { pool: "general" });
    expect(res.status).toBe(200);
    expect((db.getServer(server.id) as any).pool).toBe("general");
  });

  test("accepts an arbitrary custom pool slug and persists it", async () => {
    const server = makeServer();
    const res = await poolReq(server.id, { pool: "gold-tier" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "gold-tier" });
    expect((db.getServer(server.id) as any).pool).toBe("gold-tier");
  });

  test("rejects non-slug pools with 400 and leaves the pool unchanged", async () => {
    const server = makeServer();
    for (const pool of ["Bad Name", "-lead", "1up", "a".repeat(33), "", 42, null, undefined]) {
      const res = await poolReq(server.id, { pool });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
    }
    expect((db.getServer(server.id) as any).pool).toBe("general");
  });

  test("404 for an unknown server (even with an invalid pool)", async () => {
    const res = await poolReq(9_999_999, { pool: "nonsense" });
    expect(res.status).toBe(404);
  });
});

describe("handlePromoteApp", () => {
  test("rejects source == dest with 400", async () => {
    const app = makeApp();
    const res = await promoteReq({ source_app: app.name, dest_app: app.name });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must be different/i);
  });

  test("400 when source_app/dest_app are missing", async () => {
    const res = await promoteReq({});
    expect(res.status).toBe(400);
  });

  test("404 for unknown source or dest app", async () => {
    const app = makeApp();
    let res = await promoteReq({ source_app: "no-such-app", dest_app: app.name });
    expect(res.status).toBe(404);
    res = await promoteReq({ source_app: app.name, dest_app: "no-such-app" });
    expect(res.status).toBe(404);
  });

  test("400 when the source has no successful deployment", async () => {
    const source = makeApp();
    const dest = makeApp();
    const res = await promoteReq({ source_app: source.name, dest_app: dest.name });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no successful deployment/i);
  });
});

describe("handleGetAppStaging", () => {
  test("404 for an unknown app", async () => {
    const res = await stagingReq(9_999_999);
    expect(res.status).toBe(404);
  });

  test("standalone app: staging disabled, no sibling, null commits", async () => {
    const app = makeApp();
    const res = await stagingReq(app.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staging_enabled: boolean; staging_environment_id: number | null; prod_commit: string | null; sibling: unknown };
    expect(body).toEqual({ staging_enabled: false, staging_environment_id: null, prod_commit: null, sibling: null });
  });

  test("reflects the selected staging environment", async () => {
    const app = makeApp();
    const env = makeEnv();
    db.updateAppWebhookStagingEnvironment(app.id, env.id);
    const body = (await (await stagingReq(app.id)).json()) as { staging_enabled: boolean; staging_environment_id: number | null };
    expect(body.staging_enabled).toBe(true);
    expect(body.staging_environment_id).toBe(env.id);
  });

  test("surfaces the staging sibling and its deployed commit", async () => {
    const prod = makeApp({ target: "production" });
    const sib = makeApp({
      name: `${prod.name}-staging`,
      domain: "stage.example.com",
      target: "staging",
      target_of: prod.id,
    });
    db.insertDeployment({ app_id: sib.id, image_tag: `${sib.name}:latest`, git_commit: "abc1234", status: "deployed" });
    // A sibling of some OTHER parent must not leak in.
    const other = makeApp();
    makeApp({ name: `${other.name}-staging`, target: "staging", target_of: other.id });

    const res = await stagingReq(prod.id);
    const body = (await res.json()) as {
      sibling: { id: number; name: string; status: string; domain: string; commit: string | null } | null;
    };
    expect(body.sibling).toEqual({
      id: sib.id,
      name: sib.name,
      status: sib.status,
      domain: "stage.example.com",
      commit: "abc1234",
    });
  });
});

describe("deployToStaging", () => {
  test("no existing sibling: enqueues a create-deploy and reports created", () => {
    const prod = makeApp({ name: `base-${randomSuffix()}`, target: "production" });
    db.updateAppWebhookStagingEnvironment(prod.id, makeEnv().id);
    const res = deployToStaging(prod.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.siblingName).toBe(`${prod.name}-staging`);
    expect(typeof res.opId).toBe("number");
    // The deploy op (not this helper) creates the sibling app row; nothing yet.
    expect(db.getAppByName(`${prod.name}-staging`)).toBeNull();
  });

  test("existing sibling: enqueues a redeploy on it, created=false", () => {
    const prod = makeApp({ target: "production" });
    db.updateAppWebhookStagingEnvironment(prod.id, makeEnv().id);
    const sib = makeApp({ name: `${prod.name}-staging`, target: "staging", target_of: prod.id });
    const res = deployToStaging(prod.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(false);
    expect(res.siblingName).toBe(sib.name);
  });

  test("unknown app: ok:false", () => {
    const res = deployToStaging(9_999_999);
    expect(res.ok).toBe(false);
  });

  test("no staging environment selected: ok:false", () => {
    const prod = makeApp({ target: "production" });
    const res = deployToStaging(prod.id);
    expect(res.ok).toBe(false);
  });

  test("rejects deploying a sibling's own staging (can't stack targets)", () => {
    const prod = makeApp({ target: "production" });
    const sib = makeApp({ name: `${prod.name}-staging`, target: "staging", target_of: prod.id });
    const res = deployToStaging(sib.id);
    expect(res.ok).toBe(false);
  });
});
