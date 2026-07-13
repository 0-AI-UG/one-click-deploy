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
  req_threshold?: number;
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
      last_scale_at = ?,
      autoscale_req_threshold = ?
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
      fields.req_threshold ?? 0,
      appId,
    ],
  );
}

function setRequestsPerMin(appId: number, rpm: number) {
  const { default: conn } = require("../../shared/db/connection.ts");
  conn.run("UPDATE apps SET requests_per_min = ? WHERE id = ?", [rpm, appId]);
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

  // --- CPU normalized against the per-app --cpus limit ---
  // docker CPUPerc is cores-used×100, so the threshold must be read relative to
  // the container's CPU ceiling, not a bare 1-core assumption.

  function setCpuLimit(appId: number, cores: number) {
    const { default: conn } = require("../../shared/db/connection.ts");
    conn.run("UPDATE apps SET cpu_limit = ? WHERE id = ?", [cores, appId]);
  }

  test("cpu limit 0.5: a fully-pegged half-core replica (cpu_percent=50) scales up", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { cpu_threshold: 80, max_replicas: 4 });
    setCpuLimit(app.id, 0.5);
    const r = insertReplica({
      app_id: app.id, server_id: server.id, host_port: 21070,
      container_name: `c-cpu-half-${Date.now()}`, status: "running",
    });
    // 50% of a core = 100% of a 0.5-core limit. Scraped ceiling = 0.5.
    updateReplicaMetrics(r.id, 50, 10, { cpuLimitCores: 0.5, memoryUsedMb: 0, memoryLimitMb: 0 });

    await evaluateAutoScale(app.id);

    // Normalized util 100% / threshold 80% = 1.25 -> ceil(1*1.25) = 2. Raw
    // (unnormalized) 50/80 = 0.625 would have held at 1.
    expect(desiredOf(app.id)).toBe(2);
  });

  test("cpu limit 2: 0.8 core used of 2 allowed (cpu_percent=80) does NOT scale up", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { cpu_threshold: 80, max_replicas: 4 });
    setCpuLimit(app.id, 2);
    const r = insertReplica({
      app_id: app.id, server_id: server.id, host_port: 21071,
      container_name: `c-cpu-two-${Date.now()}`, status: "running",
    });
    // cpu_percent 80 = 0.8 core = 40% of a 2-core limit.
    updateReplicaMetrics(r.id, 80, 10, { cpuLimitCores: 2, memoryUsedMb: 0, memoryLimitMb: 0 });

    await evaluateAutoScale(app.id);

    // Normalized util 40% is below the 80% threshold. Raw 80/80 = 1.0 would
    // have sat on the scale-up boundary.
    expect(desiredOf(app.id)).toBe(1);
  });

  test("cpu limit falls back to app.cpu_limit when the replica ceiling is unscraped (0)", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { cpu_threshold: 80, max_replicas: 4 });
    setCpuLimit(app.id, 0.5);
    const r = insertReplica({
      app_id: app.id, server_id: server.id, host_port: 21072,
      container_name: `c-cpu-fallback-${Date.now()}`, status: "running",
    });
    // cpu_limit_cores left at 0 (not yet scraped) -> fall back to app.cpu_limit=0.5.
    updateReplicaMetrics(r.id, 50, 10);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(2);
  });

  // --- Request-rate scaling (HPA-style third metric, HTTP apps only) ---

  test("request-rate: high req/min per replica scales up even when CPU/mem are low", async () => {
    const server = makeServer();
    const app = makeApp(); // health_check=true => HTTP-routed
    setAutoscale(app.id, { req_threshold: 100, max_replicas: 4 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21060,
      container_name: `c-req-up-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 5, 5); // CPU/mem idle
    setRequestsPerMin(app.id, 300); // 300 rpm / 1 replica / 100 target = ratio 3
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    // ceil(1 * 3) = 3 replicas driven purely by request rate.
    expect(desiredOf(app.id)).toBe(3);
  });

  test("request-rate: stale metrics fall back to CPU/mem (no request-driven scale-up)", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { req_threshold: 100, max_replicas: 4 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21061,
      container_name: `c-req-stale-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 5, 5);
    setRequestsPerMin(app.id, 300);
    // metrics NOT marked fresh — a stale scrape must not act as a load signal

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
  });

  test("request-rate: threshold 0 disables the request signal", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { req_threshold: 0, max_replicas: 4 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21062,
      container_name: `c-req-off-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 5, 5);
    setRequestsPerMin(app.id, 9999);
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
  });

  test("request-rate: TCP app ignores req/min (no Traefik counter)", async () => {
    const server = makeServer();
    const app = makeApp({ healthCheck: false }); // TCP-routed, no auth
    setAutoscale(app.id, { req_threshold: 100, max_replicas: 4 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21063,
      container_name: `c-req-tcp-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 5, 5);
    setRequestsPerMin(app.id, 300);
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    expect(desiredOf(app.id)).toBe(1);
  });

  test("request-rate: high traffic holds replicas up (blocks CPU-idle scale-down)", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { req_threshold: 100, min_replicas: 1, max_replicas: 4 });
    const r1 = insertReplica({
      app_id: app.id, server_id: server.id, host_port: 21064,
      container_name: `c-req-hold-a-${Date.now()}`, status: "running",
    });
    const r2 = insertReplica({
      app_id: app.id, server_id: server.id, host_port: 21065,
      container_name: `c-req-hold-b-${Date.now()}`, status: "running",
    });
    const { default: conn } = require("../../shared/db/connection.ts");
    conn.run("UPDATE apps SET desired_replicas = 2 WHERE id = ?", [app.id]);
    updateReplicaMetrics(r1.id, 3, 3); // CPU idle would otherwise scale down to 1
    updateReplicaMetrics(r2.id, 3, 3);
    setRequestsPerMin(app.id, 220); // 220 / 2 replicas / 100 = ratio 1.1 (within hold band)
    markMetricsFresh(server.id);

    await evaluateAutoScale(app.id);

    // Request load keeps the ratio at target — no scale-down despite idle CPU.
    expect(desiredOf(app.id)).toBe(2);
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
