// Unit tests for pickTargetServer — capacity scoring, affinity penalty,
// 0.85 full threshold, and provisioning fallback.
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Stub provisionServer BEFORE importing server-picker (static import).
const provisionServer = mock(async (opts: { name: string; location?: string }) => ({
  id: 99_999,
  name: opts.name,
  provider_id: `h-${opts.name}`,
  provider: "hetzner",
  ipv4: "9.9.9.9",
  ipv6: "",
  type: "cx22",
  location: opts.location ?? "fsn1",
  status: "ready",
  ssh_host_key: "",
  private_ipv4: "10.0.9.9",
  created_at: new Date().toISOString(),
}));
mock.module("../provision-server.ts", () => ({ provisionServer }));

import * as db from "../../shared/db.ts";
import * as dbOrgs from "../../shared/db/orgs.ts";
import { insertServer } from "../../shared/db/servers.ts";
import { insertApp } from "../../shared/db/apps.ts";
import { insertReplica } from "../../shared/db/replicas.ts";
import { pickTargetServer } from "./server-picker.ts";
import type { App, Server } from "./types.ts";

// Each test gets a fresh org so getServers(org_id) only returns rows that
// test created — avoids bleed between cases.
function freshOrg(): string {
  const id = `picker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try { dbOrgs.insertOrg(id, id, id); } catch {}
  return id;
}

function makeServer(orgId: string, suffix: string, overrides: Partial<{ status: string; location: string }> = {}) {
  return insertServer({
    name: `srv-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    provider_id: `h-${suffix}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: overrides.location ?? "fsn1",
    status: overrides.status ?? "ready",
    org_id: orgId,
  });
}

function makeApp(orgId: string, suffix: string) {
  return insertApp({
    name: `app-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    domain: `${suffix}.example.com`,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    org_id: orgId,
  }) as unknown as App;
}

function setServerMetrics(serverId: number, cpu: number, mem: number) {
  db.insertServerMetricSample(serverId, cpu, mem);
}

const noopEmit = () => {};

beforeEach(() => {
  provisionServer.mockClear();
});

describe("pickTargetServer", () => {
  test("preferredServerId wins when ready", async () => {
    const org = freshOrg();
    const s = makeServer(org, "pref-1");
    const app = makeApp(org, "pref-1");

    const picked = await pickTargetServer(app, {}, noopEmit, s.id);
    expect(picked.id).toBe(s.id);
  });

  test("preferredServerId throws when not ready", async () => {
    const org = freshOrg();
    const s = makeServer(org, "pref-notready", { status: "provisioning" });
    const app = makeApp(org, "pref-nr");

    await expect(pickTargetServer(app, {}, noopEmit, s.id)).rejects.toThrow(/is not ready/);
  });

  test("preferredServerId throws when not found", async () => {
    const org = freshOrg();
    const app = makeApp(org, "pref-miss");
    await expect(pickTargetServer(app, {}, noopEmit, 999_999_999)).rejects.toThrow(/not found/);
  });

  test("scoring picks least-loaded server", async () => {
    const org = freshOrg();
    const busy = makeServer(org, "score-busy");
    const idleSrv = makeServer(org, "score-idle");
    // busy: load = 0.6*90 + 0.4*80 = 54+32 = 86? -> 0.86 actually above full.
    // Use values that keep both under the 0.85 cap to test scoring.
    // busy load: 0.6*70 + 0.4*60 = 42 + 24 = 66 -> 0.66 -> score 66
    // idle load: 0.6*5 + 0.4*5 = 5 -> score 5
    setServerMetrics(busy.id, 70, 60);
    setServerMetrics(idleSrv.id, 5, 5);

    const app = makeApp(org, "score");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(idleSrv.id);
  });

  test("affinity penalty shifts choice away from a server already hosting a replica", async () => {
    // Two servers with equal load. Default scoring would pick the first one
    // found; the affinity penalty (+50) pushes the one already hosting a
    // replica of this app above the other.
    const org = freshOrg();
    const s1 = makeServer(org, "affin-1");
    const s2 = makeServer(org, "affin-2");
    setServerMetrics(s1.id, 10, 10); // load 0.10 -> score 10
    setServerMetrics(s2.id, 10, 10); // load 0.10 -> score 10

    const app = makeApp(org, "affin");
    // Pin an existing replica to s1 — the affinity penalty should push s2 ahead.
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
    const org = freshOrg();
    const full = makeServer(org, "full-1");
    const ok = makeServer(org, "full-2");
    // full: 0.6*95 + 0.4*85 = 57 + 34 = 91 -> 0.91 > 0.85 -> skipped
    setServerMetrics(full.id, 95, 85);
    // ok: 0.6*50 + 0.4*50 = 50 -> 0.50
    setServerMetrics(ok.id, 50, 50);

    const app = makeApp(org, "full");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(ok.id);
  });

  test("servers with no recent metrics are treated as empty (load 0)", async () => {
    const org = freshOrg();
    const fresh = makeServer(org, "fresh-metrics"); // no metrics
    const app = makeApp(org, "fresh");

    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(fresh.id);
  });

  test("all servers full -> provisions a new one; inherits location from existing replica", async () => {
    const org = freshOrg();
    // One full server hosting an existing replica in 'ash' location.
    const full = makeServer(org, "cap", { location: "ash" });
    setServerMetrics(full.id, 99, 99); // > 0.85

    const app = makeApp(org, "prov");
    insertReplica({
      app_id: app.id,
      server_id: full.id,
      host_port: 10020,
      container_name: `${app.name}-1`,
      status: "running",
    });

    const picked = await pickTargetServer(app, { default_server_type: "cx22", default_location: "hel1" }, noopEmit);
    expect(provisionServer).toHaveBeenCalledTimes(1);
    const args = provisionServer.mock.calls[0][0];
    expect(args.location).toBe("ash"); // inherited from existing replica's server
    expect(args.serverType).toBe("cx22");
    expect(args.orgId).toBe(org);
    expect(picked.id).toBe(99_999); // from stubbed provisionServer
  });

  test("empty cluster -> provisions using settings.default_location (no replicas to inherit from)", async () => {
    const org = freshOrg();
    const app = makeApp(org, "empty");

    await pickTargetServer(app, { default_server_type: "cx22", default_location: "nbg1" }, noopEmit);
    const args = provisionServer.mock.calls[provisionServer.mock.calls.length - 1][0];
    expect(args.location).toBe("nbg1");
  });

  test("provisioning fallback throws when default_server_type is missing", async () => {
    const org = freshOrg();
    const app = makeApp(org, "nodef");
    await expect(pickTargetServer(app, {}, noopEmit)).rejects.toThrow(/default server type/);
  });

  test("skips non-ready servers in scoring loop", async () => {
    const org = freshOrg();
    const provisioning = makeServer(org, "skip-notready", { status: "provisioning" });
    const ready = makeServer(org, "skip-ready");
    // Load high on provisioning would have excluded it too — set low load so
    // only the status filter explains skipping.
    setServerMetrics(provisioning.id, 1, 1);
    setServerMetrics(ready.id, 50, 50);

    const app = makeApp(org, "skip");
    const picked = await pickTargetServer(app, {}, noopEmit);
    expect(picked.id).toBe(ready.id);
  });
});
