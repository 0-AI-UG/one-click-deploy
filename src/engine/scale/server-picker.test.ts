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
const provisionServer = mock(async (opts: { name: string; location?: string; serverType: string }) => ({
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
  created_at: new Date().toISOString(),
}));
mock.module("../provision-server.ts", () => ({ provisionServer }));

import * as db from "../../shared/db.ts";
import { insertServer } from "../../shared/db/servers.ts";
import { insertApp } from "../../shared/db/apps.ts";
import { insertReplica } from "../../shared/db/replicas.ts";
import { pickTargetServer } from "./server-picker.ts";
import type { App, Server } from "./types.ts";

function makeServer(suffix: string, overrides: Partial<{ status: string; location: string }> = {}) {
  return insertServer({
    name: `srv-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    provider_id: `h-${suffix}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: overrides.location ?? "fsn1",
    status: overrides.status ?? "ready",
  });
}

function makeApp(suffix: string) {
  return insertApp({
    name: `app-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    domain: `${suffix}.example.com`,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  }) as unknown as App;
}

function setServerMetrics(serverId: number, cpu: number, mem: number) {
  db.insertServerMetricSample(serverId, cpu, mem);
}

const noopEmit = () => {};

beforeEach(() => {
  const { default: conn } = require("../../shared/db/connection.ts");
  // Wipe everything that pickTargetServer reads to keep cases isolated.
  conn.run("DELETE FROM replicas");
  conn.run("DELETE FROM server_metrics_samples");
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
