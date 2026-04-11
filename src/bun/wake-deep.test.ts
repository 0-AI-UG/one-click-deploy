// Phase 4 — wake from deep sleep.
//
// Exercises the materializeServer + deep-wake flow in wake.ts. We mock the
// compute provider, DNS provider, and remote SSH helpers so no network is
// touched. The DB is real, so rows flow through migrations the same way they
// would in prod.

import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-wake-deep-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Compute provider mock ────────────────────────────────────────────────
// The bits we need: snapshots.createServerFromSnapshot (drives the restore),
// snapshots.delete (post-wake cleanup), ensureSshKey + ensureFirewall
// (picked up by materializeServer), and waitForRunning (no-op).

let createFromSnapshotCalls = 0;
const deletedSnapshots: string[] = [];
let nextRestoreIp = 100;

type CreateOpts = {
  name: string;
  snapshotId: string;
  serverType: string;
  location: string;
  sshKeyName: string;
  firewallId: number;
  volumeIds: string[];
};
let lastCreateOpts: CreateOpts | null = null;

// Test hook: block createServerFromSnapshot on this promise so two concurrent
// wakes can race and assert they collapse onto one provider call.
let createGate: Promise<void> | null = null;

const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  async ensureSshKey(name: string) {
    return { id: "1", name };
  },
  async ensureFirewall() {
    return "fw-1";
  },
  async waitForRunning() {},
  async deleteServer() {},
  snapshots: {
    async create() {
      return { snapshotId: "unused-in-these-tests" };
    },
    async get() {
      return { status: "available" as const, sizeGb: 10 };
    },
    async delete(id: string) {
      deletedSnapshots.push(id);
    },
    async createServerFromSnapshot(opts: CreateOpts) {
      createFromSnapshotCalls += 1;
      lastCreateOpts = opts;
      if (createGate) await createGate;
      const ip = `10.0.0.${nextRestoreIp++}`;
      return {
        providerId: `new-${createFromSnapshotCalls}`,
        ipv4: ip,
        ipv6: "",
        status: "running",
      };
    },
  },
  volumes: {
    async detach() {},
    async create() {
      throw new Error("unused");
    },
    async get() {
      throw new Error("unused");
    },
    async list() {
      return [];
    },
    async attach() {},
    async resize() {},
    async delete() {},
  },
};

// Mock with zero-snapshot capability so we can test the unsupported-provider
// error branch. Toggled at runtime via `providerHasSnapshots`.
let providerHasSnapshots = true;
mock.module("./providers/index.ts", () => ({
  getComputeProvider: () => {
    if (!providerHasSnapshots) {
      const p = { ...fakeProvider } as Record<string, unknown>;
      delete p.snapshots;
      return p;
    }
    return fakeProvider;
  },
  getDnsProvider: () => fakeDnsProvider,
}));

// ── DNS provider mock ────────────────────────────────────────────────────
const createdDnsRecords: Array<{ zoneId: string; value: string }> = [];
const deletedDnsRecords: Array<{ zoneId: string; value: string }> = [];
const fakeDnsProvider = {
  id: "hetzner-dns",
  name: "Hetzner DNS",
  async listZones() {
    return [];
  },
  async createRecord(opts: { zoneId: string; name: string; type: string; value: string }) {
    createdDnsRecords.push({ zoneId: opts.zoneId, value: opts.value });
    return { id: `rec-${createdDnsRecords.length}`, name: opts.name, type: opts.type, value: opts.value };
  },
  async deleteRecord(opts: { zoneId: string; name: string; type: string; value: string }) {
    deletedDnsRecords.push({ zoneId: opts.zoneId, value: opts.value });
  },
};

// ── Remote helpers mock ──────────────────────────────────────────────────
// The containers / health-check / caddy helpers are all no-ops for the deep
// wake flow — we only care that the materialization + bookkeeping happens.
// `containerExists` returns true so the fast path runs.

mock.module("./remote/index.ts", () => ({
  sshExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  getSshKeyPath: () => "",
  getOrCreateLocalKeyPair: async () => ({ publicKey: "ssh-ed25519 AAAA", privateKey: "" }),
  captureHostKey: async () => "host-key",
  waitForServer: async () => {},
  deployCaddySite: async () => {},
  deployCaddyWakePage: async () => {},
  deployPanelWakePage: async () => {},
  removePanelWakePage: async () => {},
  ensurePanelOnDemandTls: async () => {},
  removeCaddySite: async () => {},
  checkCaddyRoute: async () => true,
  stopContainer: async () => {},
  startContainer: async () => true,
  containerExists: async () => true,
  stopCompose: async () => {},
  startCompose: async () => {},
  composeProjectExists: async () => true,
  healthCheck: async () => ({ healthy: true }),
  composeHealthCheck: async () => ({ healthy: true }),
  deployAuthProxy: async () => {},
  removeAuthProxy: async () => {},
  authProxyPort: (p: number) => p + 1,
  pauseCompose: async () => {},
  unpauseCompose: async () => {},
  restartCompose: async () => {},
  restartContainer: async () => {},
  pauseContainer: async () => {},
  unpauseContainer: async () => {},
}));

import * as db from "./db.ts";
import { wakeApp } from "./scale/wake.ts";

function resetMockState() {
  createFromSnapshotCalls = 0;
  lastCreateOpts = null;
  deletedSnapshots.length = 0;
  createdDnsRecords.length = 0;
  deletedDnsRecords.length = 0;
  createGate = null;
  providerHasSnapshots = true;
  nextRestoreIp = 100;
}

function freshFrozenServer(name: string, opts?: { snapshotId?: string; volumeIds?: string[] }) {
  const row = db.insertServer({
    name,
    provider_id: `h-${name}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  db.markServerFrozen(row.id, {
    snapshot_id: opts?.snapshotId ?? `snap-${name}`,
    volume_ids: opts?.volumeIds ?? [],
  });
  return db.getServer(row.id)!;
}

function sleepingApp(name: string, serverId: number, hostPort: number) {
  const app = db.insertApp({
    name,
    domain: `${name}.example.com`,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
  // Light-sleep anchor — stopped replica row survives on the server.
  const replica = db.insertReplica({
    app_id: app.id,
    server_id: serverId,
    host_port: hostPort,
    container_name: app.name,
    status: "running",
  });
  db.markReplicaStopped(replica.id);
  db.updateAppSleepingState(app.id, serverId, hostPort, "wake-token");
  db.updateAppStatus(app.id, "sleeping");
  return app;
}

describe("wakeApp — deep wake", () => {
  beforeEach(() => {
    resetMockState();
  });

  test("happy path: restores server, marks app running, cleans up snapshot", async () => {
    const server = freshFrozenServer("deep-1", { snapshotId: "snap-deep-1", volumeIds: ["vol-1"] });
    const app = sleepingApp(`deep-app-${Date.now()}`, server.id, 10000);

    // DNS record that should get swapped to the new IP
    db.insertDnsRecord({
      app_id: app.id,
      zone_id: "zone-1",
      record_id: "old-rec",
      name: "deep-app",
      type: "A",
      value: "1.2.3.4",
    });

    const result = await wakeApp(app.id);
    expect(result.ok).toBe(true);

    // Server row is materialized with the new ipv4.
    const srv = db.getServer(server.id)!;
    expect(srv.state).toBe("materialized");
    expect(srv.ipv4).toMatch(/^10\.0\.0\./);
    expect(srv.provider_id).toBe("new-1");
    // snapshot_id cleared after the post-wake cleanup
    expect(srv.snapshot_id).toBe("");
    expect(db.getFrozenVolumeIds(srv)).toEqual([]);

    // createServerFromSnapshot was called with the correct opts
    expect(createFromSnapshotCalls).toBe(1);
    expect(lastCreateOpts?.snapshotId).toBe("snap-deep-1");
    expect(lastCreateOpts?.volumeIds).toEqual(["vol-1"]);
    expect(lastCreateOpts?.serverType).toBe("cx23");
    expect(lastCreateOpts?.location).toBe("nbg1");

    // Old snapshot was deleted
    expect(deletedSnapshots).toEqual(["snap-deep-1"]);

    // App is running, sleeping state cleared, replica flipped back to running.
    const after = db.getApp(app.id)!;
    expect(after.status).toBe("running");
    expect(after.sleeping_server_id).toBeNull();
    const replicas = db.getReplicasByServer(server.id).filter((r) => r.app_id === app.id);
    expect(replicas.length).toBe(1);
    expect(replicas[0].status).toBe("running");

    // DNS was swapped: new record created, old record deleted.
    expect(createdDnsRecords.length).toBe(1);
    expect(createdDnsRecords[0].value).toBe(srv.ipv4);
    expect(deletedDnsRecords.length).toBe(1);
    expect(deletedDnsRecords[0].value).toBe("1.2.3.4");
  });

  test("concurrent wakes on same frozen server collapse into one restore", async () => {
    const server = freshFrozenServer("deep-concurrent");
    const a = sleepingApp(`deep-ca-${Date.now()}`, server.id, 10000);
    const b = sleepingApp(`deep-cb-${Date.now()}`, server.id, 10001);

    // Block createServerFromSnapshot until both wakes have entered the lock.
    let releaseGate!: () => void;
    createGate = new Promise<void>((res) => {
      releaseGate = res;
    });

    const wakeA = wakeApp(a.id);
    const wakeB = wakeApp(b.id);
    // Give the second call a chance to hit materializeLocks before we unblock.
    await Bun.sleep(10);
    releaseGate();

    const [resA, resB] = await Promise.all([wakeA, wakeB]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    // Exactly one provider call for the materialization.
    expect(createFromSnapshotCalls).toBe(1);

    const srv = db.getServer(server.id)!;
    expect(srv.state).toBe("materialized");
    expect(db.getApp(a.id)!.status).toBe("running");
    expect(db.getApp(b.id)!.status).toBe("running");
  });

  test("clears wake_page_on_panel flag after successful deep wake (Phase 5)", async () => {
    const server = freshFrozenServer("deep-panel-flag", {
      snapshotId: "snap-panel-flag",
      volumeIds: [],
    });
    const app = sleepingApp(`deep-flag-${Date.now()}`, server.id, 10000);
    // Simulate what the freeze worker would have done: flip the flag on so
    // the ask endpoint authorized cert minting while the app was frozen.
    db.setAppWakePageOnPanel(app.id, true);
    expect(db.getApp(app.id)!.wake_page_on_panel).toBe(1);

    const result = await wakeApp(app.id);
    expect(result.ok).toBe(true);

    // After wake, the flag must be back to 0 — the wake path should have
    // removed the wake page route from the panel and updated the DB.
    expect(db.getApp(app.id)!.wake_page_on_panel).toBe(0);
  });

  test("fails loudly when provider lacks snapshot capability", async () => {
    const server = freshFrozenServer("deep-unsupported");
    const app = sleepingApp(`deep-unsup-${Date.now()}`, server.id, 10000);
    providerHasSnapshots = false;

    const result = await wakeApp(app.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not support snapshot restore/);

    // Server stays frozen; app marked error (not running).
    expect(db.getServer(server.id)!.state).toBe("frozen");
    expect(db.getApp(app.id)!.status).toBe("error");
    expect(createFromSnapshotCalls).toBe(0);
  });
});
