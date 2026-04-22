// Tests for reconciler-adjacent logic: metrics DB operations, autoscale
// thresholds, unhealthy ticks, and Caddy sync triggering. The reconciler
// itself uses SSH; we test the DB primitives and the evaluateAutoScale
// function (which reads DB state) directly.
import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";
import * as dbOrgs from "../shared/db/orgs.ts";

// Stub remote SSH calls so reconciler internals don't try to connect.
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  healthCheck: mock(async () => ({ healthy: true })),
  composeHealthCheck: mock(async () => ({ healthy: true })),
  restartCompose: mock(async () => {}),
  restartContainer: mock(async () => {}),
  serviceHealthCheck: mock(async () => ({ healthy: true })),
  pruneServer: mock(async () => {}),
}));

// Stub Caddy sync and network reconciler.
mock.module("../scale/caddy-manager.ts", () => ({
  syncAppCaddy: mock(async () => {}),
  removeAppCaddy: mock(async () => {}),
}));

mock.module("../scale/network-reconciler.ts", () => ({
  reconcileNetwork: mock(async () => {}),
}));

// Stub enqueue so autoscale doesn't need the IPC server.
const enqueueMock = mock((_args: unknown) => ({ opId: 999 }));
mock.module("/Users/anton/Dev/one-click-deploy/src/server/ipc/enqueue.ts", () => ({ enqueue: enqueueMock }));

import * as db from "../shared/db.ts";
import {
  insertMetricSample,
  pruneOldMetrics,
  getRecentAppMetrics,
  insertReplica,
  updateReplicaMetrics,
  incrementUnhealthyTicks,
  resetUnhealthyTicks,
  updateReplicaStatus,
} from "../shared/db/replicas.ts";
import { insertApp } from "../shared/db/apps.ts";
import { insertServer } from "../shared/db/servers.ts";
import { evaluateAutoScale } from "./scale-api.ts";
import { listPendingOperations } from "../shared/db/operations.ts";

try { dbOrgs.insertOrg("rec-org", "Reconciler Org", "rec-org"); } catch {}

function makeServer() {
  return insertServer({
    name: `srv-${Date.now()}`,
    provider_id: `h-${Date.now()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    org_id: "rec-org",
  });
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return insertApp({
    name: `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    domain: "",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    org_id: "rec-org",
    ...overrides,
  } as Parameters<typeof insertApp>[0]);
}

// ---- metrics DB operations ---------------------------------------------------

describe("reconciler: metrics written and TTL prune", () => {
  test("insertMetricSample writes a row readable by getRecentAppMetrics", () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3001,
      container_name: `c-${Date.now()}`,
      status: "running",
    });

    insertMetricSample({ replica_id: replica.id, app_id: app.id, cpu_percent: 42, memory_percent: 55 });

    const samples = getRecentAppMetrics(app.id, 60);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    const last = samples[samples.length - 1];
    expect(last.cpu_percent).toBe(42);
    expect(last.memory_percent).toBe(55);
  });

  test("pruneOldMetrics removes samples older than the TTL", () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3002,
      container_name: `c-prune-${Date.now()}`,
      status: "running",
    });

    // Insert a sample and then backdate it so it looks old.
    insertMetricSample({ replica_id: replica.id, app_id: app.id, cpu_percent: 10, memory_percent: 20 });
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run(
      "UPDATE metrics_samples SET sampled_at = datetime('now', '-3700 seconds') WHERE app_id = ?",
      [app.id],
    );

    // Prune with 1-hour TTL.
    pruneOldMetrics(3600);

    const after = getRecentAppMetrics(app.id, 3600);
    expect(after.length).toBe(0);
  });
});

// ---- unhealthy ticks ---------------------------------------------------------

describe("reconciler: unhealthy tick tracking", () => {
  test("incrementUnhealthyTicks increments and returns new value", () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3010,
      container_name: `c-ticks-${Date.now()}`,
      status: "running",
    });

    const t1 = incrementUnhealthyTicks(replica.id);
    const t2 = incrementUnhealthyTicks(replica.id);
    expect(t1).toBe(1);
    expect(t2).toBe(2);
  });

  test("resetUnhealthyTicks resets to 0", () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3011,
      container_name: `c-reset-${Date.now()}`,
      status: "running",
    });

    incrementUnhealthyTicks(replica.id);
    incrementUnhealthyTicks(replica.id);
    resetUnhealthyTicks(replica.id);

    // After reset the next increment starts from 1 again.
    const after = incrementUnhealthyTicks(replica.id);
    expect(after).toBe(1);
  });

  test("updateReplicaStatus can set replica to unhealthy", () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3012,
      container_name: `c-unhealthy-${Date.now()}`,
      status: "running",
    });

    updateReplicaStatus(replica.id, "unhealthy");
    const updated = db.getReplicaUnscoped(replica.id)!;
    expect(updated.status).toBe("unhealthy");
  });
});

// ---- autoscale thresholds ----------------------------------------------------

describe("reconciler: autoscale thresholds (evaluateAutoScale)", () => {
  async function setupAutoscaleApp(cpuPercent: number, memPercent: number, opts: {
    min_replicas?: number;
    max_replicas?: number;
    autoscale_cpu_threshold?: number;
    autoscale_mem_threshold?: number;
    autoscale_cooldown?: number;
  } = {}) {
    enqueueMock.mockClear();

    const server = makeServer();
    const { default: conn } = require("../shared/db/connection.ts");
    const app = makeApp();

    // Enable autoscale via direct SQL since insertApp doesn't expose those fields.
    conn.run(
      `UPDATE apps SET autoscale_enabled = 1,
        autoscale_cpu_threshold = ?,
        autoscale_mem_threshold = ?,
        min_replicas = ?,
        max_replicas = ?,
        autoscale_cooldown = ?,
        status = 'running'
       WHERE id = ?`,
      [
        opts.autoscale_cpu_threshold ?? 70,
        opts.autoscale_mem_threshold ?? 80,
        opts.min_replicas ?? 1,
        opts.max_replicas ?? 4,
        opts.autoscale_cooldown ?? 0,
        app.id,
      ],
    );

    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 4000 + Math.floor(Math.random() * 1000),
      container_name: `c-as-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      status: "running",
    });
    updateReplicaMetrics(replica.id, cpuPercent, memPercent);

    return app;
  }

  test("CPU above threshold enqueues scale_up", async () => {
    const app = await setupAutoscaleApp(90, 30); // cpu=90 > threshold=70

    await evaluateAutoScale(app.id);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0][0] as { kind: string };
    expect(call.kind).toBe("scale_up");
  });

  test("mem above threshold enqueues scale_up", async () => {
    const app = await setupAutoscaleApp(20, 95); // mem=95 > threshold=80

    await evaluateAutoScale(app.id);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0][0] as { kind: string };
    expect(call.kind).toBe("scale_up");
  });

  test("below threshold with multiple replicas enqueues scale_down", async () => {
    enqueueMock.mockClear();
    const server = makeServer();
    const { default: conn } = require("../shared/db/connection.ts");
    const app = makeApp();
    // 2 replicas currently, min=1, cpu/mem well below threshold*0.5
    conn.run(
      `UPDATE apps SET autoscale_enabled = 1,
        autoscale_cpu_threshold = 70, autoscale_mem_threshold = 80,
        min_replicas = 1, max_replicas = 4, autoscale_cooldown = 0, status = 'running'
       WHERE id = ?`,
      [app.id],
    );
    // Insert 2 replicas with low metrics.
    for (let i = 0; i < 2; i++) {
      const r = insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 5000 + i,
        container_name: `c-down-${Date.now()}-${i}`,
        status: "running",
      });
      updateReplicaMetrics(r.id, 5, 5); // far below 35 (70*0.5) and 40 (80*0.5)
    }

    await evaluateAutoScale(app.id);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0][0] as { kind: string };
    expect(call.kind).toBe("scale_down");
  });

  test("autoscale cooldown prevents scaling when recently scaled", async () => {
    const app = await setupAutoscaleApp(90, 30, { autoscale_cooldown: 3600 });
    // Set last_scale_at to just now so cooldown is still active.
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE apps SET last_scale_at = datetime('now') WHERE id = ?", [app.id]);

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("no autoscale action when app.autoscale_enabled is false", async () => {
    enqueueMock.mockClear();
    const server = makeServer();
    const app = makeApp();
    // autoscale_enabled = 0 by default
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 6001,
      container_name: `c-noautoscale-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(replica.id, 99, 99);

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("volume-capped app does not scale up beyond 1 replica", async () => {
    enqueueMock.mockClear();
    const server = makeServer();
    const { default: conn } = require("../shared/db/connection.ts");
    const app = makeApp();
    conn.run(
      `UPDATE apps SET autoscale_enabled = 1,
        autoscale_cpu_threshold = 70, autoscale_mem_threshold = 80,
        min_replicas = 1, max_replicas = 4, autoscale_cooldown = 0,
        volume_id = 'v-someVolume', status = 'running'
       WHERE id = ?`,
      [app.id],
    );
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 6002,
      container_name: `c-volcap-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(replica.id, 99, 99); // high CPU but volume cap prevents scale-up

    await evaluateAutoScale(app.id);

    // Should NOT enqueue scale_up because effectiveMax = min(1, 4) = 1 and replicas.length=1.
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
