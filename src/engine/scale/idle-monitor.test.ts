// Unit tests for idle-monitor: evaluateAutoScale() edges not covered by
// reconciler.test.ts (sustained-idle → sleep, 0 replicas, waking/sleeping
// skip, request-based scale-to-zero).
//
// evaluateAutoScale is now a pure decision function: it writes
// apps.desired_replicas (and records a scaling_event) and lets the reconciler's
// convergence loop perform the physical scale. These tests assert on the
// resulting desired_replicas rather than on an enqueued operation.
//
// Single-tenant: no orgs in this branch.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-idle-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Scriptable SSH mock: queue of results (or errors) keyed by call order.
type SshResult = { exitCode: number; stdout: string; stderr: string };
let sshQueue: (SshResult | Error)[] = [];
const sshExec = mock(async (_host: string, _cmd: string, _hostKey?: string) => {
  if (sshQueue.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
  const next = sshQueue.shift()!;
  if (next instanceof Error) throw next;
  return next;
});
mock.module("../../shared/remote/index.ts", () => ({
  sshExec,
  healthCheck: mock(async () => ({ healthy: true })),
}));

import { insertServer } from "../../shared/db/servers.ts";
import { insertApp, getApp } from "../../shared/db/apps.ts";
import {
  insertReplica,
  updateReplicaMetrics,
  markReplicaStopped,
} from "../../shared/db/replicas.ts";
import { evaluateAutoScale, idleSince } from "./idle-monitor.ts";
import { ingestServerRequestMetrics, resetRequestMetricsState } from "./request-metrics.ts";

/** desired_replicas as the autoscaler last decided it. */
function desiredOf(appId: number): number {
  return getApp(appId)!.desired_replicas;
}

function makeServer() {
  return insertServer({
    name: `srv-idle-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    provider_id: `h-${Date.now()}-${Math.random()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function makeApp(opts: { healthCheck?: boolean; authPassword?: string } = {}) {
  return insertApp({
    name: `idle-app-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    domain: "",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    health_check: opts.healthCheck ?? true,
    auth_password: opts.authPassword,
  });
}

/** Mark a server's request metrics as freshly scraped this tick. */
function markMetricsFresh(serverId: number) {
  ingestServerRequestMetrics(serverId, "# scrape ok\n");
}

function setLastRequestAt(appId: number, at: Date | null) {
  const { default: conn } = require("../../shared/db/connection.ts");
  conn.run("UPDATE apps SET last_request_at = ? WHERE id = ?", [at ? at.toISOString() : null, appId]);
}

beforeEach(() => {
  sshQueue = [];
  sshExec.mockClear();
  idleSince.clear();
  resetRequestMetricsState();
});

function setAutoscale(appId: number, fields: {
  cpu_threshold?: number;
  mem_threshold?: number;
  min_replicas?: number;
  max_replicas?: number;
  cooldown?: number;
  status?: string;
  scale_to_zero_after?: number;
  volume_id?: string;
  last_scale_at?: string | null;
}) {
  const { default: conn } = require("../../shared/db/connection.ts");
  conn.run(
    `UPDATE apps SET autoscale_enabled = 1,
      autoscale_cpu_threshold = ?,
      autoscale_mem_threshold = ?,
      min_replicas = ?,
      max_replicas = ?,
      autoscale_cooldown = ?,
      scale_to_zero_after = ?,
      volume_id = ?,
      status = ?,
      last_scale_at = ?
     WHERE id = ?`,
    [
      fields.cpu_threshold ?? 70,
      fields.mem_threshold ?? 80,
      fields.min_replicas ?? 1,
      fields.max_replicas ?? 4,
      fields.cooldown ?? 0,
      fields.scale_to_zero_after ?? 300,
      fields.volume_id ?? "",
      fields.status ?? "running",
      fields.last_scale_at ?? null,
      appId,
    ],
  );
}

describe("evaluateAutoScale", () => {
  test("app with 0 non-stopped replicas is ignored (desired unchanged)", async () => {
    const app = makeApp();
    setAutoscale(app.id, {});
    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  test("replicas with status='stopped' are filtered out (single stopped anchor = idle)", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, {});
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21001,
      container_name: `c-only-${Date.now()}`,
      status: "running",
    });
    markReplicaStopped(r.id);

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  test("app status='sleeping' is skipped and clears idleSince tracker", async () => {
    const app = makeApp();
    setAutoscale(app.id, { status: "sleeping" });
    idleSince.set(app.id, Date.now());

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("app status='waking' is skipped", async () => {
    const app = makeApp();
    setAutoscale(app.id, { status: "waking" });

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  test("autoscale_enabled=0 is a no-op", async () => {
    const server = makeServer();
    const app = makeApp();
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21010,
      container_name: `c-off-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 99, 99);

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  // TCP-routed apps (health_check=0, no auth) have no Traefik request
  // counters, so they keep the legacy CPU sustained-idle sleep path.
  test("legacy sustained-idle (TCP app): first idle tick sets idleSince and does NOT sleep", async () => {
    const server = makeServer();
    const app = makeApp({ healthCheck: false });
    setAutoscale(app.id, { min_replicas: 0, scale_to_zero_after: 300 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21020,
      container_name: `c-sleep1-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 1, 1);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
    expect(idleSince.has(app.id)).toBe(true);
  });

  test("legacy sustained-idle (TCP app): second tick after idleTimeout elapsed sleeps (desired=0) and clears tracker", async () => {
    const server = makeServer();
    const app = makeApp({ healthCheck: false });
    setAutoscale(app.id, { min_replicas: 0, scale_to_zero_after: 1 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21021,
      container_name: `c-sleep2-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 1, 1);

    idleSince.set(app.id, Date.now() - 10_000);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(0);
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("legacy path: at-target metrics clear an existing idleSince entry", async () => {
    const server = makeServer();
    const app = makeApp({ healthCheck: false });
    setAutoscale(app.id, { min_replicas: 0 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21022,
      container_name: `c-recover-${Date.now()}`,
      status: "running",
    });
    // At target (ratio ≈ 1.0, within the tolerance band) — neither idle nor
    // overloaded, so the idle tracker is cleared and desired holds.
    updateReplicaMetrics(r.id, 70, 70);
    idleSince.set(app.id, Date.now() - 1000);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("cooldown still active -> no change even with scale-up-level CPU", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { cooldown: 3600, last_scale_at: new Date().toISOString() });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21030,
      container_name: `c-cool-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 95, 10);

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  test("cooldown expired -> scales up (desired increases)", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, {
      cooldown: 60,
      last_scale_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21031,
      container_name: `c-expired-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 95, 10);

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(2);
  });

  test("proportional scale-up: desired jumps toward the load ratio", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { max_replicas: 5 });
    for (let i = 0; i < 2; i++) {
      const r = insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 21040 + i,
        container_name: `c-up-${Date.now()}-${i}`,
        status: "running",
      });
      updateReplicaMetrics(r.id, 95, 10);
    }

    await evaluateAutoScale(app.id);

    // ratio = 95/70 ≈ 1.36; ceil(2 × 1.36) = 3.
    expect(desiredOf(app.id)).toBe(3);
  });

  // --- request-based scale-to-zero (HTTP-routed apps) -----------------------

  function setupHttpSleepApp(opts: { lastRequestAt?: Date | null; authPassword?: string; healthCheck?: boolean } = {}) {
    const server = makeServer();
    const app = makeApp({ healthCheck: opts.healthCheck, authPassword: opts.authPassword });
    setAutoscale(app.id, { min_replicas: 0, scale_to_zero_after: 300 });
    setLastRequestAt(app.id, opts.lastRequestAt === undefined ? null : opts.lastRequestAt);
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21100 + Math.floor(Math.random() * 100),
      container_name: `c-req-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 1, 1);
    return { server, app };
  }

  test("request-based sleep: fresh metrics + no requests for the window sleeps (desired=0)", async () => {
    const { server, app } = setupHttpSleepApp({ lastRequestAt: new Date(Date.now() - 600_000) });
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(0);
    // The request path never uses the CPU idle tracker.
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("request-based sleep: recent request keeps the app awake even at idle CPU", async () => {
    const { server, app } = setupHttpSleepApp({ lastRequestAt: new Date(Date.now() - 10_000) });
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);
    expect(desiredOf(app.id)).toBe(1);
  });

  test("request-based sleep fail-safe: stale/missing scrape skips the sleep decision", async () => {
    const lastRequestAt = new Date(Date.now() - 600_000);
    const { app } = setupHttpSleepApp({ lastRequestAt });
    // No markMetricsFresh — the replica's server was never scraped.

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
    // last_request_at is untouched: a stale server means "unknown", not "idle".
    expect(getApp(app.id)!.last_request_at).toBe(lastRequestAt.toISOString());
  });

  test("request-based sleep: NULL last_request_at is seeded, not slept on", async () => {
    const { server, app } = setupHttpSleepApp({ lastRequestAt: null });
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
    expect(getApp(app.id)!.last_request_at).not.toBeNull();
  });

  test("auth-protected health_check=0 app is HTTP-routed and uses the request path", async () => {
    const { server, app } = setupHttpSleepApp({
      lastRequestAt: new Date(Date.now() - 600_000),
      healthCheck: false,
      authPassword: "hunter2",
    });
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(0);
  });

  test("volume-capped: max_replicas is clamped to 1 regardless of stored value", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { max_replicas: 10, volume_id: "vol-abc" });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21050,
      container_name: `c-volcap-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 99, 99);

    await evaluateAutoScale(app.id);
    // Already at the volume cap of 1 — no scale-up despite 99% load.
    expect(desiredOf(app.id)).toBe(1);
  });
});
