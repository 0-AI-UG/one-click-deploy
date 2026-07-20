import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";

// Bypass auth for all tests (same pattern as apps-auth.test.ts).
mock.module("../lib/permissions.ts", () => ({
  requireAdmin: async () => ({ userId: "admin", username: "admin" }),
  requirePermission: async () => ({ userId: "admin", username: "admin" }),
}));

// apps.ts imports the Traefik manager at module load; stub it (no live proxy).
mock.module("../../engine/scale/traefik-manager.ts", () => ({
  syncAppIngress: async () => {},
  getPanelIngressIpv4: () => null,
}));

import * as db from "../../shared/db.ts";
import { handleGetAppTargets, handlePromoteApp, handleCreateAppTarget, handleSetAppPool } from "./apps.ts";
import { handleSetServerPool } from "./servers.ts";
import { handleGetPools } from "./pools.ts";

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

const targetsReq = (appId: number) =>
  handleGetAppTargets(new Request(`http://x/api/apps/${appId}/targets`), appId);

const poolReq = (serverId: number, body: unknown) =>
  handleSetServerPool(
    new Request(`http://x/api/servers/${serverId}/pool`, { method: "PATCH", body: JSON.stringify(body) }),
    serverId,
  );

const promoteReq = (body: unknown) =>
  handlePromoteApp(new Request("http://x/api/apps/promote", { method: "POST", body: JSON.stringify(body) }));

const createTargetReq = (appId: number, body: unknown) =>
  handleCreateAppTarget(
    new Request(`http://x/api/apps/${appId}/targets`, { method: "POST", body: JSON.stringify(body) }),
    appId,
  );

const appPoolReq = (appId: number, body: unknown) =>
  handleSetAppPool(
    new Request(`http://x/api/apps/${appId}/pool`, { method: "PATCH", body: JSON.stringify(body) }),
    appId,
  );

const poolsReq = () => handleGetPools(new Request("http://x/api/pools"));

describe("handleGetAppTargets", () => {
  test("returns {self, targets} with the parent's staging/dev children", async () => {
    const parent = makeApp({ domain: "prod.example.com", target: "production" });
    const child = makeApp({
      name: `${parent.name}-staging`,
      domain: "stage.example.com",
      target: "staging",
      target_of: parent.id,
    });
    // A sibling app pointing at some OTHER parent must not leak in.
    const other = makeApp();
    makeApp({ target: "dev", target_of: other.id });

    const res = await targetsReq(parent.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      self: { id: number; name: string; target: string };
      targets: Array<{ id: number; name: string; target: string; status: string; domain: string }>;
    };
    expect(body.self).toMatchObject({ id: parent.id, name: parent.name, target: "production" });
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]).toEqual({
      id: child.id,
      name: child.name,
      target: "staging",
      status: child.status,
      domain: "stage.example.com",
    });
  });

  test("standalone app: empty targets list, self.target ''", async () => {
    const app = makeApp();
    const res = await targetsReq(app.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { self: { target: string }; targets: unknown[] };
    expect(body.self.target).toBe("");
    expect(body.targets).toEqual([]);
  });

  test("404 for an unknown app", async () => {
    const res = await targetsReq(9_999_999);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });
});

describe("contract: handleGetAppTargets self.parent (T4)", () => {
  // REGRESSION: currently failing by design — pinned desired behavior
  test("a target app's self carries parent {id, name} resolved from target_of", async () => {
    const parent = makeApp({ target: "production" });
    const child = makeApp({ name: `${parent.name}-staging`, target: "staging", target_of: parent.id });

    const res = await targetsReq(child.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { self: { parent?: { id: number; name: string } | null } };
    expect(body.self.parent).toEqual({ id: parent.id, name: parent.name });
  });

  // REGRESSION: currently failing by design — pinned desired behavior
  test("standalone/production apps get parent: null", async () => {
    const app = makeApp();
    const res = await targetsReq(app.id);
    const body = (await res.json()) as { self: Record<string, unknown> };
    // Explicit null (field present), not merely absent.
    expect("parent" in body.self).toBe(true);
    expect(body.self.parent).toBeNull();
  });
});

describe("handleCreateAppTarget", () => {
  test("enqueues a deploy for an isolated <name>-<target> sibling", async () => {
    const app = makeApp({ name: `base-${randomSuffix()}`, target: "production" });
    const res = await createTargetReq(app.id, { target: "Staging" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { op_id: number; app_name: string };
    // Target name is slugged; the sibling is `<name>-<target>`.
    expect(body.app_name).toBe(`${app.name}-staging`);
    expect(typeof body.op_id).toBe("number");
    // The deploy op (not this handler) creates the sibling app; nothing yet.
    expect(db.getAppByName(`${app.name}-staging`)).toBeNull();
  });

  test("404 for an unknown app", async () => {
    const res = await createTargetReq(9_999_999, { target: "staging" });
    expect(res.status).toBe(404);
  });

  test("400 when target is missing or not a slug", async () => {
    const app = makeApp({ target: "production" });
    for (const target of [undefined, "", "Bad Name", "-lead", "1up"]) {
      const res = await createTargetReq(app.id, { target });
      expect(res.status).toBe(400);
    }
  });

  test('400 when target is "production" (that is the app itself)', async () => {
    const app = makeApp({ target: "production" });
    const res = await createTargetReq(app.id, { target: "production" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/app itself/i);
  });

  test("400 when the app is itself a target sibling", async () => {
    const parent = makeApp({ target: "production" });
    const child = makeApp({ name: `${parent.name}-staging`, target: "staging", target_of: parent.id });
    const res = await createTargetReq(child.id, { target: "dev" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/production parent/i);
  });

  test("409 when the target sibling already exists", async () => {
    const app = makeApp({ target: "production" });
    makeApp({ name: `${app.name}-staging`, target: "staging", target_of: app.id });
    const res = await createTargetReq(app.id, { target: "staging" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already exists/i);
  });
});

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

describe("handleSetAppPool", () => {
  test("re-pools an app into a custom slug and persists placement_pool", async () => {
    const app = makeApp();
    const res = await appPoolReq(app.id, { pool: "gold-tier" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "gold-tier" });
    expect((db.getApp(app.id) as any).placement_pool).toBe("gold-tier");
  });

  test("404 for an unknown app", async () => {
    const res = await appPoolReq(9_999_999, { pool: "staging" });
    expect(res.status).toBe(404);
  });

  test("400 for a non-slug or over-long pool, leaving the pool unchanged", async () => {
    const app = makeApp();
    const before = (db.getApp(app.id) as any).placement_pool;
    for (const pool of ["Bad Name", "-lead", "1up", "a".repeat(33), "", 42, null, undefined]) {
      const res = await appPoolReq(app.id, { pool });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
    expect((db.getApp(app.id) as any).placement_pool).toBe(before);
  });
});

describe("handleGetPools", () => {
  test("returns the sorted, de-duplicated union incl. the always-present defaults", async () => {
    // Defaults are present even with no custom assignments.
    let res = await poolsReq();
    expect(res.status).toBe(200);
    let body = (await res.json()) as { pools: string[] };
    expect(body.pools).toContain("general");
    expect(body.pools).toContain("staging");

    // Assign a server and an app to distinct custom pools; both surface.
    const server = makeServer();
    await poolReq(server.id, { pool: "gold-tier" });
    const app = makeApp();
    await appPoolReq(app.id, { pool: "silver" });

    res = await poolsReq();
    body = (await res.json()) as { pools: string[] };
    expect(body.pools).toEqual([...body.pools].sort());
    expect(new Set(body.pools).size).toBe(body.pools.length);
    expect(body.pools).toEqual(expect.arrayContaining(["general", "staging", "gold-tier", "silver"]));
  });
});
