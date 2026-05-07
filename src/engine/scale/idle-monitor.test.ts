// Unit tests for idle-monitor: collectMetrics() (docker-stats parsing, SSH
// failure resilience, stopped-replica skip) and evaluateAutoScale() edges
// not covered by reconciler.test.ts (sustained-idle → sleep, 0 replicas,
// waking/sleeping skip).
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

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

// Stub enqueue so evaluateAutoScale doesn't need the IPC server.
const enqueueMock = mock((_args: unknown) => ({ opId: 42 }));
mock.module("/Users/anton/Dev/one-click-deploy/src/server/ipc/enqueue.ts", () => ({
  enqueue: enqueueMock,
}));

import * as db from "../../shared/db.ts";
import * as dbOrgs from "../../shared/db/orgs.ts";
import { insertServer } from "../../shared/db/servers.ts";
import { insertApp } from "../../shared/db/apps.ts";
import { insertReplica, updateReplicaMetrics, markReplicaStopped } from "../../shared/db/replicas.ts";
import { collectMetrics, evaluateAutoScale, idleSince } from "./idle-monitor.ts";

const ORG = "idle-org";
try { dbOrgs.insertOrg(ORG, "Idle Org", ORG); } catch {}

function makeServer() {
  return insertServer({
    name: `srv-idle-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    provider_id: `h-${Date.now()}-${Math.random()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    org_id: ORG,
  });
}

function makeApp() {
  return insertApp({
    name: `idle-app-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    domain: "",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    org_id: ORG,
  });
}

beforeEach(() => {
  sshQueue = [];
  sshExec.mockClear();
  enqueueMock.mockClear();
  idleSince.clear();
});

describe("collectMetrics", () => {
  test("parses 'NN.NN%' strings into floats and writes to DB", async () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20001,
      container_name: `c-stat-${Date.now()}`,
      status: "running",
    });

    sshQueue.push({
      exitCode: 0,
      stdout: JSON.stringify({ CPUPerc: "12.34%", MemPerc: "56.78%" }),
      stderr: "",
    });

    await collectMetrics(app.id);

    const after = db.getReplicaUnscoped(replica.id)!;
    expect(after.cpu_percent).toBeCloseTo(12.34, 2);
    expect(after.memory_percent).toBeCloseTo(56.78, 2);
  });

  test("skips replicas with status='stopped' (light-sleep anchors)", async () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20002,
      container_name: `c-stopped-${Date.now()}`,
      status: "running",
    });
    markReplicaStopped(replica.id);

    await collectMetrics(app.id);

    expect(sshExec).not.toHaveBeenCalled();
  });

  test("malformed stats (non-zero exit) are skipped, DB left untouched", async () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20003,
      container_name: `c-bad-${Date.now()}`,
      status: "running",
    });
    // Seed known values so we can detect any mutation.
    updateReplicaMetrics(replica.id, 7, 8);

    sshQueue.push({ exitCode: 1, stdout: "", stderr: "no such container" });

    await collectMetrics(app.id);

    const after = db.getReplicaUnscoped(replica.id)!;
    expect(after.cpu_percent).toBe(7);
    expect(after.memory_percent).toBe(8);
  });

  test("missing CPUPerc/MemPerc fields parse as 0 (|| '0' fallback)", async () => {
    const server = makeServer();
    const app = makeApp();
    const replica = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20004,
      container_name: `c-empty-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(replica.id, 99, 99);

    sshQueue.push({ exitCode: 0, stdout: "{}", stderr: "" });

    await collectMetrics(app.id);

    const after = db.getReplicaUnscoped(replica.id)!;
    expect(after.cpu_percent).toBe(0);
    expect(after.memory_percent).toBe(0);
  });

  test("SSH failure on one replica does not stop the loop (caught per-replica)", async () => {
    const server = makeServer();
    const app = makeApp();
    const r1 = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20005,
      container_name: `c-fail-${Date.now()}`,
      status: "running",
    });
    const r2 = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 20006,
      container_name: `c-ok-${Date.now()}`,
      status: "running",
    });

    sshQueue.push(new Error("ssh boom"));
    sshQueue.push({
      exitCode: 0,
      stdout: JSON.stringify({ CPUPerc: "33.3%", MemPerc: "44.4%" }),
      stderr: "",
    });

    // Should resolve without throwing.
    await collectMetrics(app.id);

    const a1 = db.getReplicaUnscoped(r1.id)!;
    const a2 = db.getReplicaUnscoped(r2.id)!;
    expect(a1.cpu_percent).toBe(0); // never updated
    expect(a2.cpu_percent).toBeCloseTo(33.3, 1);
  });
});

// Helpers for autoscale tests that need to flip autoscale fields directly.
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
  test("app with 0 non-stopped replicas is ignored (no enqueue)", async () => {
    const app = makeApp();
    setAutoscale(app.id, {});
    // No replicas inserted at all.

    await evaluateAutoScale(app.id);
    expect(enqueueMock).not.toHaveBeenCalled();
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
    markReplicaStopped(r.id); // now stopped — filter() drops it, replicas.length = 0

    await evaluateAutoScale(app.id);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("app status='sleeping' is skipped and clears idleSince tracker", async () => {
    const app = makeApp();
    setAutoscale(app.id, { status: "sleeping" });
    idleSince.set(app.id, Date.now());

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("app status='waking' is skipped", async () => {
    const app = makeApp();
    setAutoscale(app.id, { status: "waking" });

    await evaluateAutoScale(app.id);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("autoscale_enabled=0 is a no-op", async () => {
    const server = makeServer();
    const app = makeApp();
    // leave autoscale_enabled = 0 (default from insertApp)
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21010,
      container_name: `c-off-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 99, 99);

    await evaluateAutoScale(app.id);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("sustained-idle: first idle tick sets idleSince and does NOT enqueue sleep", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { min_replicas: 0, scale_to_zero_after: 300 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21020,
      container_name: `c-sleep1-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 1, 1); // far below 70*0.5=35 and 80*0.5=40

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(idleSince.has(app.id)).toBe(true);
  });

  test("sustained-idle: second tick after idleTimeout elapsed enqueues sleep and clears tracker", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { min_replicas: 0, scale_to_zero_after: 1 }); // 1s threshold
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21021,
      container_name: `c-sleep2-${Date.now()}`,
      status: "running",
    });
    updateReplicaMetrics(r.id, 1, 1);

    // Pre-seed idleSince to 10s ago — well past the 1s idleTimeout.
    idleSince.set(app.id, Date.now() - 10_000);

    await evaluateAutoScale(app.id);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0][0] as { kind: string; input: unknown };
    expect(call.kind).toBe("sleep");
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("non-idle metrics clear an existing idleSince entry", async () => {
    const server = makeServer();
    const app = makeApp();
    setAutoscale(app.id, { min_replicas: 0 });
    const r = insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 21022,
      container_name: `c-recover-${Date.now()}`,
      status: "running",
    });
    // Metrics between idle (50% of threshold) and scale-up threshold → no action,
    // and idleSince must be cleared.
    updateReplicaMetrics(r.id, 50, 50); // 50 > 35 and 50 > 40 → not idle
    idleSince.set(app.id, Date.now() - 1000);

    await evaluateAutoScale(app.id);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(idleSince.has(app.id)).toBe(false);
  });

  test("cooldown still active -> no enqueue even with scale-up-level CPU", async () => {
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
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("cooldown expired -> scale_up fires", async () => {
    const server = makeServer();
    const app = makeApp();
    // last_scale_at 1h ago, cooldown 60s -> expired.
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
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect((enqueueMock.mock.calls[0][0] as { kind: string }).kind).toBe("scale_up");
  });

  test("scale_up enqueues targetReplicas = current + 1", async () => {
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

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = enqueueMock.mock.calls[0][0] as { kind: string; input: { targetReplicas: number } };
    expect(call.kind).toBe("scale_up");
    expect(call.input.targetReplicas).toBe(3);
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
    // 1 replica, effectiveMax = min(1,10) = 1 → no scale_up
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
