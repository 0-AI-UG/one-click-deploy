// Unit tests for pickTargetServer — capacity scoring, affinity penalty,
// 0.85 full threshold, and provisioning fallback.
//
// Single-tenant: this branch's getServers() returns ALL servers (no org
// scoping). To prevent bleed between cases we truncate the servers (and
// related) tables in beforeEach.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-picker-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Stub provisionServer BEFORE importing server-picker (static import).
const provisionServer = mock(async (opts: { name: string; location?: string; serverType: string; pool?: string }) => ({
  id: 99_999,
  name: opts.name,
  provider_id: `h-${opts.name}`,
  ipv4: "9.9.9.9",
  ipv6: "",
  type: opts.serverType,
  location: opts.location ?? "fsn1",
  status: "ready",
  ssh_host_key: "",
  private_ipv4: "10.0.9.9",
  pool: opts.pool ?? "general",
  created_at: new Date().toISOString(),
}));
mock.module("../provision-server.ts", () => ({ provisionServer }));

import * as db from "../../shared/db.ts";
import { insertServer } from "../../shared/db/servers.ts";
import { insertApp } from "../../shared/db/apps.ts";
import { insertReplica } from "../../shared/db/replicas.ts";
import { pickTargetServer } from "./server-picker.ts";
import type { App, Server } from "./types.ts";

function makeServer(suffix: string, overrides: Partial<{ status: string; location: string; pool: string }> = {}) {
  return insertServer({
    name: `srv-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    provider_id: `h-${suffix}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: overrides.location ?? "fsn1",
    status: overrides.status ?? "ready",
    pool: overrides.pool ?? "general",
  });
}

function makeApp(
  suffix: string,
  overrides: Partial<{ placement_pool: string; max_per_host: number; min_locations: number }> = {},
) {
  return insertApp({
    name: `app-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    domain: `${suffix}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    placement_pool: overrides.placement_pool,
    max_per_host: overrides.max_per_host,
    min_locations: overrides.min_locations,
  }) as unknown as App;
}

function setServerMetrics(serverId: number, cpu: number, mem: number) {
  db.insertServerMetricSample(serverId, cpu, mem);
}

const noopEmit = () => {};

beforeEach(() => {
  const { default: conn } = require("../../shared/db/connection.ts");
  // Wipe everything that pickTargetServer reads to keep cases isolated.
  db.deletePanel();
  conn.run("DELETE FROM replicas");
  conn.run("DELETE FROM service_instances");
  conn.run("DELETE FROM port_reservations");
  conn.run("DELETE FROM server_metrics_samples");
  conn.run("UPDATE apps SET build_source_id = NULL");
  conn.run("DELETE FROM build_sources");
  conn.run("DELETE FROM build_workers");
  conn.run("DELETE FROM servers");
  conn.run("DELETE FROM apps");
  provisionServer.mockClear();
});

describe("pickTargetServer", () => {
  test("preferredServerId wins when ready", async () => {
    const s = makeServer("pref-1");
    const app = makeApp("pref-1");

    const picked = await pickTargetServer(app, {}, noopEmit, s.id);
    expect(picked.id).toBe(s.id);
  });

  test("preferredServerId throws when not ready", async () => {
    const s = makeServer("pref-notready", { status: "provisioning" });
    const app = makeApp("pref-nr");

    await expect(pickTargetServer(app, {}, noopEmit, s.id)).rejects.toThrow(/is not ready/);
  });

  test("preferredServerId throws when not found", async () => {
    const app = makeApp("pref-miss");
    await expect(pickTargetServer(app, {}, noopEmit, 999_999_999)).rejects.toThrow(/not found/);
  });

  test("scoring picks least-loaded server", async () => {
    const busy = makeServer("score-busy");
    const idleSrv = makeServer("score-idle");
    setServerMetrics(busy.id, 70, 60);  // load 0.66 -> score 66
    setServerMetrics(idleSrv.id, 5, 5); // load 0.05 -> score 5

    const app = makeApp("score");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(idleSrv.id);
  });

  test("affinity penalty shifts choice away from a server already hosting a replica", async () => {
    const s1 = makeServer("affin-1");
    const s2 = makeServer("affin-2");
    setServerMetrics(s1.id, 10, 10);
    setServerMetrics(s2.id, 10, 10);

    const app = makeApp("affin");
    insertReplica({
      app_id: app.id,
      server_id: s1.id,
      host_port: 10001,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(s2.id);
  });

  test("skips servers above the 0.85 full threshold", async () => {
    const full = makeServer("full-1");
    const ok = makeServer("full-2");
    setServerMetrics(full.id, 95, 85); // 0.91 -> skipped
    setServerMetrics(ok.id, 50, 50);   // 0.50

    const app = makeApp("full");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(ok.id);
  });

  test("servers with no recent metrics are treated as empty (load 0)", async () => {
    const fresh = makeServer("fresh-metrics");
    const app = makeApp("fresh");

    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(fresh.id);
  });

  test("automatic placement excludes the control-plane host", async () => {
    const panelServer = makeServer("panel");
    db.insertPanel({
      server_id: panelServer.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      host_port: 3000,
    });
    const worker = makeServer("worker");
    setServerMetrics(panelServer.id, 1, 1);
    setServerMetrics(worker.id, 70, 70);
    const app = makeApp("off-panel");

    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(worker.id);
  });

  test("build workers are excluded from explicit and automatic app placement", async () => {
    const runnerServer = makeServer("runner");
    db.insertBuildWorker({
      serverId: runnerServer.id,
      name: "ocd-runner-1",
      previousPool: "general",
    });
    db.updateServerPool(runnerServer.id, "build-workers");
    const worker = makeServer("app-worker");
    const app = makeApp("runner-isolation");

    await expect(pickTargetServer(app, {}, noopEmit, runnerServer.id)).rejects.toThrow(/reserved for OCD builds/);
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(worker.id);
  });

  test("all servers full -> provisions a new one; inherits location from existing replica", async () => {
    const full = makeServer("cap", { location: "ash" });
    setServerMetrics(full.id, 99, 99);

    const app = makeApp("prov");
    insertReplica({
      app_id: app.id,
      server_id: full.id,
      host_port: 10020,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(
      app,
      { default_server_type: "cx22", default_location: "hel1" },
      noopEmit,
    );
    expect(provisionServer).toHaveBeenCalledTimes(1);
    const args = provisionServer.mock.calls[0][0];
    expect(args.location).toBe("ash");
    expect(args.serverType).toBe("cx22");
    expect(picked.id).toBe(99_999);
  });

  test("empty cluster -> provisions using settings.default_location (no replicas to inherit from)", async () => {
    const app = makeApp("empty");

    await pickTargetServer(
      app,
      { default_server_type: "cx22", default_location: "nbg1" },
      noopEmit,
    );
    const args = provisionServer.mock.calls[provisionServer.mock.calls.length - 1][0];
    expect(args.location).toBe("nbg1");
  });

  test("provisioning fallback throws when default_server_type is missing", async () => {
    const app = makeApp("nodef");
    await expect(pickTargetServer(app, {}, noopEmit)).rejects.toThrow(/default server type/);
  });

  test("skips non-ready servers in scoring loop", async () => {
    const provisioning = makeServer("skip-notready", { status: "provisioning" });
    const ready = makeServer("skip-ready");
    setServerMetrics(provisioning.id, 1, 1);
    setServerMetrics(ready.id, 50, 50);

    const app = makeApp("skip");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(ready.id);
  });
});

// Regression coverage for the placement/durability foundation: pool filtering,
// hard per-host anti-affinity (max_per_host), and multi-location spread
// (min_locations). Every case pins behavior the pre-feature picker did NOT have
// — a reverted picker (no pool filter / no cap / no spread) fails these.
describe("durability placement", () => {
  const provSettings = { default_server_type: "cx22", default_location: "fsn1" };

  test("pool filter: staging app schedules onto the staging-pool server, not the idler general one", async () => {
    // General server is the MORE attractive pick by load — only the pool filter
    // keeps the staging app off it.
    const gen = makeServer("pool-gen", { pool: "general" });
    const stg = makeServer("pool-stg", { pool: "staging" });
    setServerMetrics(gen.id, 1, 1);   // idle → would win on load alone
    setServerMetrics(stg.id, 50, 50); // busier, but the only pool match

    const app = makeApp("pool", { placement_pool: "staging" });
    const picked = await pickTargetServer(app, provSettings, noopEmit);
    expect(picked.id).toBe(stg.id);
    expect(provisionServer).not.toHaveBeenCalled();
  });

  test("pool filter: no staging-pool server → provisions one into the staging pool", async () => {
    const gen = makeServer("pool-only-gen", { pool: "general" });
    setServerMetrics(gen.id, 1, 1);

    const app = makeApp("pool-prov", { placement_pool: "staging" });
    const picked = await pickTargetServer(app, provSettings, noopEmit);
    expect(provisionServer).toHaveBeenCalledTimes(1);
    expect(provisionServer.mock.calls[0][0].pool).toBe("staging");
    expect(picked.id).toBe(99_999); // the stub's server
  });

  test("hard anti-affinity: max_per_host:1 sends the next replica to a different host", async () => {
    const a = makeServer("aff-a");
    const b = makeServer("aff-b");
    setServerMetrics(a.id, 1, 1);   // A is far less loaded — would win without the cap
    setServerMetrics(b.id, 80, 80); // B busier but under the 0.85 full threshold

    const app = makeApp("aff", { max_per_host: 1 });
    insertReplica({
      app_id: app.id,
      server_id: a.id,
      host_port: 10001,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(app, provSettings, noopEmit);
    expect(picked.id).toBe(b.id); // A is at its per-host cap, so B wins despite higher load
    expect(provisionServer).not.toHaveBeenCalled();
  });

  test("hard anti-affinity: cap hit and the only server is full → provisions", async () => {
    const a = makeServer("aff-only");
    setServerMetrics(a.id, 1, 1);

    const app = makeApp("aff-prov", { max_per_host: 1 });
    insertReplica({
      app_id: app.id,
      server_id: a.id,
      host_port: 10001,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(app, provSettings, noopEmit);
    expect(provisionServer).toHaveBeenCalledTimes(1);
    expect(picked.id).toBe(99_999);
  });

  test("multi-location spread: uncovered location wins over a lower-load covered one", async () => {
    const fsn = makeServer("spread-fsn", { location: "fsn1" });
    const nbg = makeServer("spread-nbg", { location: "nbg1" });
    setServerMetrics(fsn.id, 5, 5);   // low load, but its location is already covered
    setServerMetrics(nbg.id, 60, 60); // higher load, but an uncovered location

    const app = makeApp("spread", { min_locations: 2 });
    insertReplica({
      app_id: app.id,
      server_id: fsn.id,
      host_port: 10001,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(app, provSettings, noopEmit);
    // Without spread logic fsn wins (load 5 + affinity 50 = 55 < nbg 60); the
    // location penalty flips it to the uncovered nbg1 server.
    expect(picked.id).toBe(nbg.id);
    expect(provisionServer).not.toHaveBeenCalled();
  });

  test("multi-location spread: every ready server is in the covered location → provisions", async () => {
    const fsn1 = makeServer("spread2-a", { location: "fsn1" });
    const fsn2 = makeServer("spread2-b", { location: "fsn1" });
    setServerMetrics(fsn1.id, 5, 5);
    setServerMetrics(fsn2.id, 5, 5);

    const app = makeApp("spread-prov", { min_locations: 2 });
    insertReplica({
      app_id: app.id,
      server_id: fsn1.id,
      host_port: 10001,
      container_name: `${app.name}-1`,
      status: "running",
    });

    await pickTargetServer(app, { default_server_type: "cx22", default_location: "nbg1" }, noopEmit);
    expect(provisionServer).toHaveBeenCalledTimes(1);
  });

  test("default app: does not schedule onto a staging-pool server", async () => {
    const stg = makeServer("def-stg", { pool: "staging" });
    setServerMetrics(stg.id, 5, 5);

    const app = makeApp("def"); // defaults: placement_pool 'general', max_per_host 0, min_locations 1
    const picked = await pickTargetServer(app, provSettings, noopEmit);
    expect(picked.id).not.toBe(stg.id); // staging server is not in the app's pool
    expect(provisionServer).toHaveBeenCalledTimes(1);
  });

  test("default app: uses the least-loaded general server exactly as before", async () => {
    const busy = makeServer("def-busy");
    const idle = makeServer("def-idle");
    setServerMetrics(busy.id, 70, 60);
    setServerMetrics(idle.id, 5, 5);

    const app = makeApp("def-load");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(idle.id);
    expect(provisionServer).not.toHaveBeenCalled();
  });

  test("no-double-count regression: scale 1→3 with max_per_host:1 lands on 3 distinct hosts, no provisioning", async () => {
    // Reproduces the scale-up loop that once ran away. scale-up.ts now calls
    // pickTargetServer WITHOUT a plannedByServer map and inserts each replica
    // before the next pick, so the per-host cap is enforced purely off the DB.
    // The old bug counted each new replica in BOTH the DB rows AND an in-pass
    // planned map, so effectiveCount = 2 after the first placement, over-
    // excluding hosts and provisioning needlessly on the 2nd/3rd pick. If that
    // double-count returned, provisionServer would fire and the picks would not
    // spread cleanly — this test fails.
    const s1 = makeServer("ndc-1");
    const s2 = makeServer("ndc-2");
    const s3 = makeServer("ndc-3");
    setServerMetrics(s1.id, 10, 10);
    setServerMetrics(s2.id, 20, 20);
    setServerMetrics(s3.id, 30, 30);

    const app = makeApp("ndc", { max_per_host: 1 });

    const picked: number[] = [];
    for (let i = 0; i < 3; i++) {
      const server = await pickTargetServer(app, provSettings, noopEmit); // NOTE: no plannedByServer arg
      picked.push(server.id);
      // Persist immediately, exactly like scale-up.ts does between iterations.
      insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 10000 + i,
        container_name: `${app.name}-${i + 1}`,
        status: "running",
      });
    }

    expect(new Set(picked).size).toBe(3); // three DISTINCT hosts
    expect(provisionServer).not.toHaveBeenCalled();
  });
});
