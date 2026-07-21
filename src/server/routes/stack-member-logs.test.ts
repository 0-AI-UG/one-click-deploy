import { useTempDataDir, randomSuffix, seedTestAdmin } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, afterAll } from "bun:test";

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

// Every member's log is one ssh round trip; record the calls so we can assert
// the fan-out covers members (and only members) and asks for timestamps.
// `mock.module` is process-wide, so spread the real module through — replacing
// it wholesale would strip sshExec & co from every other suite in the run.
const logCalls: Array<{ ip: string; container: string; tail: number; timestamps?: boolean }> = [];
const remote = await import("../../shared/remote/index.ts");
mock.module("../../shared/remote/index.ts", () => ({
  ...remote,
  getContainerLogs: async (ip: string, container: string, tail: number, _hostKey?: string, timestamps?: boolean) => {
    logCalls.push({ ip, container, tail, timestamps });
    if (container === "broken") throw new Error("ssh refused");
    return `2026-07-21T10:00:00.000000000Z line from ${container}`;
  },
}));

import * as db from "../../shared/db.ts";
import { handleGetStackMemberLogs } from "./stacks.ts";

function makeServer() {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: randomSuffix(),
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "nbg1",
    status: "running",
  });
}

function makeApp(stackId: number, overrides: Record<string, unknown> = {}) {
  const app = db.insertApp({
    name: `app-${randomSuffix()}`,
    domain: "",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    ...overrides,
  } as Parameters<typeof db.insertApp>[0]);
  db.setAppStack(app.id, stackId);
  return app;
}

// The whole suite shares one temp database, and other files wipe `servers`
// wholesale — leaving replicas/instances behind here would trip their FK.
afterAll(() => {
  const { default: conn } = require("../../shared/db/connection.ts");
  conn.run("DELETE FROM service_instances");
  conn.run("DELETE FROM replicas");
  conn.run("DELETE FROM servers");
});

const req = (stackId: number, tail?: number) =>
  handleGetStackMemberLogs(
    new Request(`http://x/api/stacks/${stackId}/member-logs${tail ? `?tail=${tail}` : ""}`),
    stackId,
  );

describe("GET /api/stacks/:id/member-logs", () => {
  test("returns one timestamped block per member and skips staging siblings", async () => {
    const stack = db.insertStack({ name: `stack-${randomSuffix()}`, environment_id: db.insertEnvironment(`env-${randomSuffix()}`, "{}").id });
    const server = makeServer();

    const app = makeApp(stack.id);
    db.insertReplica({ app_id: app.id, server_id: server.id, host_port: 20001, container_name: "app-main" });
    // Staging sibling: follows its production app, so it is not a member of the
    // stack's log stream in its own right.
    const sibling = makeApp(stack.id, { target_of: app.id });
    db.insertReplica({ app_id: sibling.id, server_id: server.id, host_port: 20002, container_name: "app-staging" });

    const service = db.insertService({
      name: `svc-${randomSuffix()}`,
      service_type: "postgres",
      version: "16",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    } as Parameters<typeof db.insertService>[0]);
    db.setServiceStack(service.id, stack.id);
    db.insertServiceInstance({ service_id: service.id, server_id: server.id, role: "primary", container_name: "svc-main", host_port: 5432 });

    logCalls.length = 0;
    const body = await (await req(stack.id, 50)).json() as { members: Array<{ name: string; kind: string; logs: string; error?: string }> };

    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.kind).sort()).toEqual(["app", "service"]);
    expect(logCalls.map((c) => c.container).sort()).toEqual(["app-main", "svc-main"]);
    expect(logCalls.every((c) => c.timestamps === true && c.tail === 50)).toBe(true);
    expect(body.members[0].logs).toContain("2026-07-21T10:00:00");
  });

  test("an unreachable member fails alone, not the whole view", async () => {
    const stack = db.insertStack({ name: `stack-${randomSuffix()}`, environment_id: db.insertEnvironment(`env-${randomSuffix()}`, "{}").id });
    const server = makeServer();
    const ok = makeApp(stack.id);
    db.insertReplica({ app_id: ok.id, server_id: server.id, host_port: 20003, container_name: "fine" });
    const bad = makeApp(stack.id);
    db.insertReplica({ app_id: bad.id, server_id: server.id, host_port: 20004, container_name: "broken" });
    // A member that was never deployed has no replica at all.
    makeApp(stack.id);

    const body = await (await req(stack.id)).json() as { members: Array<{ id: number; logs: string; error?: string }> };
    expect(body.members).toHaveLength(3);
    expect(body.members.find((m) => m.id === ok.id)?.error).toBeUndefined();
    expect(body.members.find((m) => m.id === bad.id)?.error).toContain("ssh refused");
    expect(body.members.filter((m) => m.error).length).toBe(2);
  });

  test("404s for an unknown stack", async () => {
    expect((await req(999999)).status).toBe(404);
  });
});
