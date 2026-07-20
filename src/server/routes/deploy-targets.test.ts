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
import { handleGetAppTargets, handlePromoteApp } from "./apps.ts";
import { handleSetServerPool } from "./servers.ts";

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

  test("rejects invalid pools with 400 and leaves the pool unchanged", async () => {
    const server = makeServer();
    for (const pool of ["gold", "", 42, null, undefined]) {
      const res = await poolReq(server.id, { pool });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('"general" or "staging"');
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
