// Tests for reconciler-adjacent logic: metrics DB operations, autoscale
// thresholds, unhealthy ticks. The reconciler itself uses SSH; we test the
// DB primitives and the evaluateAutoScale function (which reads DB state)
// directly.
//
// Single-tenant: this branch has no orgs, so all rows are inserted without
// org_id and apps/servers use simpler DB schemas than saas.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-reconciler-test-"));

import { describe, test, expect, mock } from "bun:test";

// mock.module factories must cover the COMPLETE export surface of the mocked
// module: Bun module namespaces are sealed, so a later re-mock (or a later
// test file importing an export this factory omits, e.g.
// scale/network-reconciler.test.ts importing syncInternalHosts) cannot add
// slots the first factory left out. Spread the real namespace and override
// only what must be stubbed.
import * as realRemote from "../shared/remote/index.ts";
import * as realTraefikManager from "./scale/traefik-manager.ts";
import * as realNetworkReconciler from "./scale/network-reconciler.ts";

// Stub remote SSH calls so reconciler internals don't try to connect.
// Named refs so individual tests can override behavior per call.
const healthCheckMock = mock(async (): Promise<{ healthy: boolean; error?: string }> => ({ healthy: true }));
const restartContainerMock = mock(async () => {});
mock.module("../shared/remote/index.ts", () => ({
  ...realRemote,
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  healthCheck: healthCheckMock,
  restartContainer: restartContainerMock,
  serviceHealthCheck: mock(async () => ({ healthy: true })),
  pruneServer: mock(async () => {}),
}));

// Stub ingress sync and network reconciler so they don't fire SSH.
mock.module("./scale/traefik-manager.ts", () => ({
  ...realTraefikManager,
  syncAppIngress: mock(async () => {}),
  syncAllTraefik: mock(async () => {}),
  reconcileTraefik: mock(async () => {}),
  ensureTraefikInstalled: mock(async () => {}),
}));

mock.module("./scale/network-reconciler.ts", () => ({
  ...realNetworkReconciler,
  reconcileNetwork: mock(async () => {}),
}));

// Stub enqueue so autoscale doesn't need the IPC server.
const enqueueMock = mock((_args: unknown) => ({ opId: 999 }));
mock.module("../server/ipc/enqueue.ts", () => ({
  enqueue: enqueueMock,
}));

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
  getReplica,
} from "../shared/db/replicas.ts";
import { insertApp } from "../shared/db/apps.ts";
import { insertServer } from "../shared/db/servers.ts";
import { evaluateAutoScale } from "./scale/index.ts";
import { checkReplicaHealth } from "./health.ts";
import { parseDockerStats, parseContainerLimits, parseDockerSizeToMb } from "./metrics-parse.ts";

function makeServer() {
  return insertServer({
    name: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    provider_id: `h-${Date.now()}-${Math.random()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function makeApp(overrides: Partial<Parameters<typeof insertApp>[0]> = {}) {
  return insertApp({
    name: `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    domain: "",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    ...overrides,
  });
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

    insertMetricSample({ replica_id: replica.id, app_id: app.id, cpu_percent: 10, memory_percent: 20 });
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run(
      "UPDATE metrics_samples SET sampled_at = datetime('now', '-3700 seconds') WHERE app_id = ?",
      [app.id],
    );

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
    const updated = getReplica(replica.id)!;
    expect(updated.status).toBe("unhealthy");
  });
});

// ---- paused-state guards -------------------------------------------------
// Regression tests for the reconciler restarting deliberately paused
// containers: a pause op can land while a health check is in flight, and the
// stale result must not clobber the paused status or trigger auto-restart.

describe("reconciler: health checks respect paused state", () => {
  function makeHealthFixture(appStatus = "running") {
    const server = makeServer();
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE servers SET routing_address = '10.0.0.9' WHERE id = ?", [server.id]);
    const app = makeApp();
    conn.run("UPDATE apps SET status = ? WHERE id = ?", [appStatus, app.id]);
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 7000 + Math.floor(Math.random() * 1000),
      container_name: `c-pauseguard-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      status: "running",
    });
    return {
      server: db.getServer(server.id)!,
      app: db.getApp(app.id)!,
      replica: getReplica(replica.id)!,
    };
  }

  test("failed check does not clobber a replica paused mid-check", async () => {
    const { server, app, replica } = makeHealthFixture();
    restartContainerMock.mockClear();
    healthCheckMock.mockImplementationOnce(async () => {
      // Pause op lands while the check is in flight.
      updateReplicaStatus(replica.id, "paused");
      return { healthy: false, error: "HTTP no response" };
    });

    await checkReplicaHealth(replica, app, server);

    expect(getReplica(replica.id)!.status).toBe("paused");
    expect(restartContainerMock).not.toHaveBeenCalled();
  });

  test("healthy check does not flip a replica paused mid-check back to running", async () => {
    const { server, app, replica } = makeHealthFixture();
    healthCheckMock.mockImplementationOnce(async () => {
      updateReplicaStatus(replica.id, "paused");
      return { healthy: true };
    });

    await checkReplicaHealth(replica, app, server);

    expect(getReplica(replica.id)!.status).toBe("paused");
  });

  test("healthy liveness does not erase a revision attestation failure", async () => {
    const { server, app, replica } = makeHealthFixture();
    db.recordReplicaAttestation(replica.id, {
      imageDigest: "sha256:observed",
      desiredImageDigest: "sha256:desired",
      envHash: "sha256:env",
      configRevision: app.config_revision,
      error: "image mismatch",
    });
    healthCheckMock.mockImplementationOnce(async () => ({ healthy: true }));

    await checkReplicaHealth(replica, app, server);

    expect(getReplica(replica.id)!.status).toBe("divergent");
    expect(getReplica(replica.id)!.attestation_error).toBe("image mismatch");
  });

  test("no auto-restart at threshold when the app is paused", async () => {
    const { server, app, replica } = makeHealthFixture("paused");
    restartContainerMock.mockClear();
    // Already one strike; this failed check reaches UNHEALTHY_RESTART_THRESHOLD.
    incrementUnhealthyTicks(replica.id);
    healthCheckMock.mockImplementationOnce(async () => ({ healthy: false, error: "HTTP no response" }));

    await checkReplicaHealth(replica, app, server);

    expect(restartContainerMock).not.toHaveBeenCalled();
  });

  test("unhealthy running replica still auto-restarts at threshold", async () => {
    const { server, app, replica } = makeHealthFixture();
    restartContainerMock.mockClear();
    incrementUnhealthyTicks(replica.id);
    healthCheckMock.mockImplementationOnce(async () => ({ healthy: false, error: "HTTP no response" }));

    await checkReplicaHealth(replica, app, server);

    expect(restartContainerMock).toHaveBeenCalledTimes(1);
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

  test("CPU above threshold raises desired_replicas", async () => {
    const app = await setupAutoscaleApp(90, 30);

    await evaluateAutoScale(app.id);

    // ratio = 90/70 ≈ 1.29 → desired 1 → 2.
    expect(db.getApp(app.id)!.desired_replicas).toBe(2);
  });

  test("mem above threshold raises desired_replicas", async () => {
    const app = await setupAutoscaleApp(20, 95);

    await evaluateAutoScale(app.id);

    // ratio = 95/80 ≈ 1.19 → desired 1 → 2.
    expect(db.getApp(app.id)!.desired_replicas).toBe(2);
  });

  test("below threshold with multiple replicas lowers desired_replicas", async () => {
    const server = makeServer();
    const { default: conn } = require("../shared/db/connection.ts");
    const app = makeApp();
    conn.run(
      `UPDATE apps SET autoscale_enabled = 1,
        autoscale_cpu_threshold = 70, autoscale_mem_threshold = 80,
        min_replicas = 1, max_replicas = 4, autoscale_cooldown = 0, status = 'running',
        desired_replicas = 2
       WHERE id = ?`,
      [app.id],
    );
    for (let i = 0; i < 2; i++) {
      const r = insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 5000 + i + Math.floor(Math.random() * 1000),
        container_name: `c-down-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5)}`,
        status: "running",
      });
      updateReplicaMetrics(r.id, 5, 5);
    }

    await evaluateAutoScale(app.id);

    // Idle at 2 replicas, floor is min_replicas=1 → desired 2 → 1.
    expect(db.getApp(app.id)!.desired_replicas).toBe(1);
  });

  test("autoscale cooldown prevents scaling when recently scaled", async () => {
    const app = await setupAutoscaleApp(90, 30, { autoscale_cooldown: 3600 });
    const { default: conn } = require("../shared/db/connection.ts");
    conn.run("UPDATE apps SET last_scale_at = datetime('now') WHERE id = ?", [app.id]);

    await evaluateAutoScale(app.id);

    expect(db.getApp(app.id)!.desired_replicas).toBe(1);
  });

  test("no autoscale action when app.autoscale_enabled is false", async () => {
    enqueueMock.mockClear();
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 6001 + Math.floor(Math.random() * 1000),
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
      host_port: 6002 + Math.floor(Math.random() * 1000),
      container_name: `c-volcap-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(replica.id, 99, 99);

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("docker metrics parsing", () => {
  test("parseDockerSizeToMb converts binary units to MiB", () => {
    expect(parseDockerSizeToMb("512MiB")).toBeCloseTo(512, 3);
    expect(parseDockerSizeToMb("1.5GiB")).toBeCloseTo(1536, 3);
    expect(parseDockerSizeToMb("410.5MiB")).toBeCloseTo(410.5, 3);
    expect(parseDockerSizeToMb("1048576B")).toBeCloseTo(1, 3);
    expect(parseDockerSizeToMb("garbage")).toBe(0);
  });

  test("parseDockerStats extracts percentages and MemUsage used/limit", () => {
    const stdout = [
      '{"Name":"app-1","CPUPerc":"42.50%","MemPerc":"80.10%","MemUsage":"410MiB / 512MiB"}',
      '{"Name":"app-2","CPUPerc":"0.00%","MemPerc":"5.00%","MemUsage":"25.6MiB / 512MiB"}',
      "not json — skipped",
    ].join("\n");
    const stats = parseDockerStats(stdout);
    expect(stats.size).toBe(2);
    const a = stats.get("app-1")!;
    expect(a.cpu).toBeCloseTo(42.5, 2);
    expect(a.mem).toBeCloseTo(80.1, 2);
    expect(a.memUsedMb).toBeCloseTo(410, 1);
    expect(a.memLimitMb).toBeCloseTo(512, 1);
    expect(a.cpuLimitCores).toBe(0); // filled in later from inspect
  });

  test("parseContainerLimits maps stripped names to CPU cores", () => {
    const stdout = [
      "/app-1 1000000000",
      "/app-2 500000000",
      "/app-3 0", // unlimited -> 0
      "malformed",
    ].join("\n");
    const limits = parseContainerLimits(stdout);
    expect(limits.get("app-1")).toBe(1);
    expect(limits.get("app-2")).toBe(0.5);
    expect(limits.get("app-3")).toBe(0);
    expect(limits.has("malformed")).toBe(false);
  });
});
