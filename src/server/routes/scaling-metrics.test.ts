import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";

// Bypass auth for all tests.
mock.module("../lib/permissions.ts", () => ({
  requireAdmin: async () => ({ userId: "admin", username: "admin" }),
  requirePermission: async () => ({ userId: "admin", username: "admin" }),
}));

// GET /api/apps/:id/metrics serves the reconciler's already-persisted
// per-replica metrics straight from the DB — it imports no remote/SSH layer,
// so this test asserts the persisted rows come back verbatim.
import * as db from "../../shared/db.ts";
import { handleGetAppMetrics } from "./scaling.ts";

function makeServer() {
  return db.insertServer({
    name: `srv-m-${Math.random().toString(36).slice(2, 6)}`,
    provider_id: `h-${Math.random()}`,
    ipv4: "10.0.0.9",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function makeApp() {
  return db.insertApp({
    name: `m-app-${Math.random().toString(36).slice(2, 6)}`,
    domain: "",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

describe("handleGetAppMetrics", () => {
  test("serves the persisted cpu_percent/memory_percent from db.getReplicas, no SSH", async () => {
    const server = makeServer();
    const app = makeApp();
    const replica = db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 22001,
      container_name: `c-m-${Date.now()}`,
      status: "running",
    });
    // Simulate a reconciler tick having written fresh metrics.
    db.updateReplicaMetrics(replica.id, 41.5, 62.25);

    const res = await handleGetAppMetrics(
      new Request(`http://x/api/apps/${app.id}/metrics`),
      app.id,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: number; cpu_percent: number; memory_percent: number }>;
    const row = body.find((r) => r.id === replica.id)!;
    expect(row.cpu_percent).toBeCloseTo(41.5, 2);
    expect(row.memory_percent).toBeCloseTo(62.25, 2);
  });
});
