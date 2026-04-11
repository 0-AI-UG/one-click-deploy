// Isolated DB for the freeze worker tests.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-freeze-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Provider mock ────────────────────────────────────────────────────────
// The freeze worker reaches for getComputeProvider() in three places:
// snapshots.{create,get,delete}, volumes.detach, and deleteServer. We mock
// all three and let each test push state/side-effects into closed-over vars.

type SnapshotState = "creating" | "available" | "failed";
const snapshotStates = new Map<string, SnapshotState>();
let nextSnapshotId = 1;

const createdSnapshots: string[] = [];
const deletedSnapshots: string[] = [];
const detachedVolumes: string[] = [];
const deletedServers: string[] = [];

// `getSnapshotCallback` lets a test observe each snapshots.get call and
// drive cancellation mid-poll.
let onGetSnapshot: ((id: string) => void) | null = null;
// Drives snapshots.list() — the freeze worker uses this for the Phase 7
// quota guard. Each entry stands in for "an existing panel-managed
// snapshot on the provider". Default empty.
let existingSnapshots: string[] = [];

const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  async deleteServer(id: string) {
    deletedServers.push(id);
  },
  volumes: {
    async detach(volumeId: string) {
      detachedVolumes.push(volumeId);
    },
    // Unused in these tests but the type requires them.
    async create() { throw new Error("unused"); },
    async get() { throw new Error("unused"); },
    async list() { return []; },
    async attach() {},
    async resize() {},
    async delete() {},
  },
  snapshots: {
    async create(_serverId: string, _desc: string) {
      const id = `snap-${nextSnapshotId++}`;
      snapshotStates.set(id, "available"); // default: ready on first poll
      createdSnapshots.push(id);
      return { snapshotId: id };
    },
    async get(id: string) {
      if (onGetSnapshot) onGetSnapshot(id);
      const state = snapshotStates.get(id) ?? "creating";
      return { status: state, sizeGb: 10 };
    },
    async delete(id: string) {
      deletedSnapshots.push(id);
      snapshotStates.delete(id);
    },
    async list() {
      return existingSnapshots.map((id) => ({
        snapshotId: id,
        description: "",
        sizeGb: 10,
        status: "available" as const,
      }));
    },
    async createServerFromSnapshot() { throw new Error("unused"); },
  },
};

const fakeDnsProvider = {
  id: "hetzner-dns",
  name: "Hetzner DNS",
  listZones: async () => [],
  createRecord: async () => ({ id: "1", name: "", type: "", value: "" }),
  deleteRecord: async () => {},
};

mock.module("./providers/index.ts", () => ({
  getComputeProvider: () => fakeProvider,
  getDnsProvider: () => fakeDnsProvider,
}));

// Track panel-handoff side-effects so tests can assert they fired.
const panelWakePageInstalls: string[] = [];
const panelOnDemandTlsCalls: number[] = [];

// SSH exec is called for the `umount` step. Make it a no-op.
mock.module("./remote/index.ts", () => ({
  sshExec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  getSshKeyPath: () => "",
  getOrCreateLocalKeyPair: async () => ({ publicKey: "", privateKey: "" }),
  captureHostKey: async () => "",
  waitForServer: async () => {},
  deployCaddySite: async () => {},
  deployCaddyWakePage: async () => {},
  deployPanelWakePage: async (_ip: string, _panelDomain: string, domain: string) => {
    panelWakePageInstalls.push(domain);
  },
  removePanelWakePage: async () => {},
  ensurePanelOnDemandTls: async () => {
    panelOnDemandTlsCalls.push(Date.now());
  },
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
import {
  _runFreezeJobForTest,
  _startFreezeJobForTest,
  _setTimingsForTest,
  cancelFreezeForServer,
  isFreezeActive,
} from "./scale/freeze-worker.ts";

_setTimingsForTest({ pollMs: 5, timeoutMs: 10_000 });

function resetProviderState() {
  snapshotStates.clear();
  createdSnapshots.length = 0;
  deletedSnapshots.length = 0;
  detachedVolumes.length = 0;
  deletedServers.length = 0;
  panelWakePageInstalls.length = 0;
  panelOnDemandTlsCalls.length = 0;
  nextSnapshotId = 1;
  onGetSnapshot = null;
  existingSnapshots = [];
}

/**
 * Install a panel row pointing at a *different* server from the one being
 * frozen. The Phase 5 handoff step in doFreeze() looks up the panel row
 * and its server to install wake pages there, so every happy-path freeze
 * test needs one in place before the worker runs.
 */
function ensurePanel() {
  if (db.getPanel()) return;
  const panelServer = db.insertServer({
    name: "panel",
    provider_id: `panel-${Date.now()}-${Math.random()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  db.insertPanel({
    server_id: panelServer.id,
    name: "ocd-panel",
    domain: "panel.example.com",
    git_repo: "x",
    container_port: 3001,
    host_port: 10000,
  });
}

function freshServer(name: string) {
  return db.insertServer({
    name,
    provider_id: `h-${name}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
}

function freshApp(name: string) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

/**
 * Insert a managed DNS A record for an app so the freeze-eligibility gate
 * accepts it. Tests that want to exercise the freeze flow on a real domain
 * must call this — the gate refuses apps with no managed DNS.
 */
function withDnsRecord(app: { id: number; domain: string }) {
  db.insertDnsRecord({
    app_id: app.id,
    zone_id: "zone-1",
    record_id: `rec-${app.id}-${Date.now()}-${Math.random()}`,
    name: app.domain,
    type: "A",
    value: "1.2.3.4",
  });
}

function stoppedAnchor(appId: number, serverId: number, hostPort: number, containerName: string) {
  const replica = db.insertReplica({
    app_id: appId,
    server_id: serverId,
    host_port: hostPort,
    container_name: containerName,
    status: "running",
  });
  db.markReplicaStopped(replica.id);
  return replica;
}

describe("enqueueFreezeJob dedupe", () => {
  beforeEach(() => {
    resetProviderState();
    db.deletePanel();
  });

  test("returns the existing job row when a pending job already exists", () => {
    const server = freshServer("dedupe");
    const a = db.enqueueFreezeJob(server.id);
    const b = db.enqueueFreezeJob(server.id);
    expect(b.id).toBe(a.id);
  });

  test("creates a fresh job after the previous one terminated", () => {
    const server = freshServer("dedupe-terminal");
    const a = db.enqueueFreezeJob(server.id);
    db.updateFreezeJobState(a.id, "done");
    const b = db.enqueueFreezeJob(server.id);
    expect(b.id).not.toBe(a.id);
  });
});

describe("freezeServerIfEmpty dispatch", () => {
  beforeEach(() => {
    resetProviderState();
    db.deletePanel();
  });

  test("no-op when the server still has running replicas", async () => {
    const server = freshServer("still-running");
    const app = freshApp(`app-sr-${Date.now()}`);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    await db.freezeServerIfEmpty(server.id);
    expect(db.getActiveFreezeJobForServer(server.id)).toBeNull();
    expect(deletedServers.length).toBe(0);
  });

  test("enqueues a freeze job when the server has only stopped anchors", async () => {
    const server = freshServer("anchor");
    const app = freshApp(`app-anchor-${Date.now()}`);
    stoppedAnchor(app.id, server.id, 10000, app.name);
    await db.freezeServerIfEmpty(server.id);
    const job = db.getActiveFreezeJobForServer(server.id);
    expect(job).toBeTruthy();
    expect(job!.state).toBe("pending");
  });

  test("skips the panel's own server", async () => {
    const server = freshServer("panel");
    const app = freshApp(`app-panel-${Date.now()}`);
    stoppedAnchor(app.id, server.id, 10000, app.name);
    db.insertPanel({
      server_id: server.id,
      name: "panel",
      domain: "panel.example.com",
      git_repo: "x",
      container_port: 3000,
      host_port: 10000,
    });
    await db.freezeServerIfEmpty(server.id);
    expect(db.getActiveFreezeJobForServer(server.id)).toBeNull();
    db.deletePanel();
  });

  test("falls back to gc when the server is truly empty", async () => {
    const server = freshServer("empty");
    await db.freezeServerIfEmpty(server.id);
    expect(deletedServers.length).toBe(1);
    expect(db.getServer(server.id)).toBeFalsy();
  });
});

describe("runFreezeJob full flow", () => {
  beforeEach(() => {
    resetProviderState();
    db.deletePanel();
  });

  test("happy path: pending → snapshotting → finalizing → done", async () => {
    ensurePanel();
    const server = freshServer("freeze-happy");
    const app = freshApp(`app-freeze-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);
    db.updateAppVolume(app.id, "vol-1", "/mnt/data:/data");
    // Phase 5: scale-down would have assigned a wake token before freeze.
    db.updateAppSleepingState(app.id, server.id, 10000, "tok-freeze-happy");

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("done");
    expect(after?.snapshot_id).toMatch(/^snap-/);

    // Phase 5 side-effects: on-demand TLS bootstrapped on the panel, wake
    // page installed on the panel for this app's domain, and the flag set
    // so the ask endpoint will authorize cert minting.
    expect(panelOnDemandTlsCalls.length).toBeGreaterThan(0);
    expect(panelWakePageInstalls).toContain(app.domain);
    expect(db.getApp(app.id)?.wake_page_on_panel).toBe(1);

    // Existing side effects: volume detached, instance destroyed, server frozen.
    expect(detachedVolumes).toEqual(["vol-1"]);
    expect(deletedServers.length).toBe(1);
    const srv = db.getServer(server.id);
    expect(srv?.state).toBe("frozen");
    expect(srv?.snapshot_id).toBe(after!.snapshot_id);
    expect(srv?.provider_id).toBe("");
    expect(srv?.ipv4).toBe("");
    expect(db.getFrozenVolumeIds(srv!)).toEqual(["vol-1"]);
  });

  test("fails + rolls back snapshot when no panel is configured", async () => {
    // No ensurePanel() — the handoff must fail loudly rather than
    // destroy an instance whose DNS has nowhere to point.
    const server = freshServer("freeze-no-panel");
    const app = freshApp(`app-no-panel-${Date.now()}`);
    withDnsRecord(app); // pass the eligibility gate
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("panel");

    // The snapshot we created must be cleaned up (orphan guard).
    expect(deletedSnapshots.length).toBe(1);
    // Instance must still be alive; server row still materialized.
    expect(deletedServers.length).toBe(0);
    expect(db.getServer(server.id)?.state).toBe("materialized");
    expect(db.getServer(server.id)?.freeze_failed_at).toBeTruthy();
    // App must not have been marked as panel-hosted.
    expect(db.getApp(app.id)?.wake_page_on_panel).toBe(0);
  });

  test("aborts cleanly when a running replica reappears before snapshot starts", async () => {
    const server = freshServer("raced");
    const app = freshApp(`app-raced-${Date.now()}`);
    // Insert a running replica — simulates a wake that landed before the
    // tick picked up the pending job.
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("cancelled");
    expect(deletedServers.length).toBe(0);
    // Server row untouched.
    expect(db.getServer(server.id)?.state).toBe("materialized");
  });

  test("cancel during snapshot polling deletes the snapshot and leaves the server alive", async () => {
    ensurePanel();
    const server = freshServer("cancel-mid-poll");
    const app = freshApp(`app-cancel-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const job = db.enqueueFreezeJob(server.id);

    // First poll returns "creating" and schedules a cancel; by the time the
    // second poll runs, the snapshot has reached "available" so the worker
    // exits the poll loop, sees ctx.cancelled=true, deletes the snapshot,
    // and marks the job cancelled. This mirrors the real-world constraint:
    // you can't cancel mid-snapshot-creation, you have to wait for the image
    // to settle and then delete it.
    let firstPoll = true;
    onGetSnapshot = (id) => {
      if (firstPoll) {
        firstPoll = false;
        snapshotStates.set(id, "creating");
        queueMicrotask(() => {
          // Request cancel (sets ctx.cancelled=true synchronously) and
          // arrange for the next poll to unblock the loop.
          void cancelFreezeForServer(server.id);
          snapshotStates.set(id, "available");
        });
      }
    };

    const runPromise = _startFreezeJobForTest(job.id);
    await runPromise;

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("cancelled");
    // Snapshot was created then deleted as part of cancellation cleanup.
    expect(createdSnapshots.length).toBe(1);
    expect(deletedSnapshots.length).toBe(1);
    expect(deletedServers.length).toBe(0);
    expect(db.getServer(server.id)?.state).toBe("materialized");
    expect(isFreezeActive(server.id)).toBe(false);
  });

  test("refuses to freeze when snapshot quota is at the limit (Phase 7)", async () => {
    ensurePanel();
    const server = freshServer("quota");
    const app = freshApp(`app-quota-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);

    // Set the quota to 3 and pre-populate the provider with 3 existing
    // snapshots. The worker must refuse to even start the snapshot create.
    _setTimingsForTest({ quotaLimit: 3 });
    existingSnapshots = ["pre-1", "pre-2", "pre-3"];

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("quota");

    // No snapshot created, no destructive side-effects. Server stays
    // materialized so it can keep serving traffic.
    expect(createdSnapshots.length).toBe(0);
    expect(deletedSnapshots.length).toBe(0);
    expect(deletedServers.length).toBe(0);
    const srv = db.getServer(server.id);
    expect(srv?.state).toBe("materialized");
    expect(srv?.freeze_failed_at).toBeTruthy();

    // Reset for the other tests.
    _setTimingsForTest({ quotaLimit: 95 });
  });

  test("marks failed + freeze_failed_at when snapshot build fails", async () => {
    const server = freshServer("snapshot-fail");
    const app = freshApp(`app-fail-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);

    onGetSnapshot = (id) => {
      snapshotStates.set(id, "failed");
    };

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("snapshot build failed");

    const srv = db.getServer(server.id);
    expect(srv?.state).toBe("materialized");
    expect(srv?.freeze_failed_at).toBeTruthy();
    expect(deletedServers.length).toBe(0);
  });
});

describe("freeze eligibility gate", () => {
  // The gate refuses to freeze any server hosting an app that can't survive
  // the panel-hosted-wake-page handoff. The whole point is to fail BEFORE
  // any provider I/O — no umount, no snapshot, no destruction. Apps without
  // managed DNS would otherwise have a working freeze flow up until the
  // instance is destroyed, at which point their domain points at a dead IP.
  beforeEach(() => {
    resetProviderState();
    db.deletePanel();
  });

  test("refuses freeze for an app with no managed DNS records", async () => {
    ensurePanel();
    const server = freshServer("ineligible-no-dns");
    const app = freshApp(`app-no-dns-${Date.now()}`);
    // No withDnsRecord(app) — domain is real but we don't own a zone.
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("cannot deep-freeze");
    expect(after?.error).toContain("no managed DNS");

    // No provider I/O at all — the gate runs before umount/snapshot.
    expect(createdSnapshots.length).toBe(0);
    expect(deletedSnapshots.length).toBe(0);
    expect(deletedServers.length).toBe(0);

    // Server stays materialized, app stays in light sleep, panel flag never set.
    const srv = db.getServer(server.id);
    expect(srv?.state).toBe("materialized");
    expect(srv?.freeze_failed_at).toBeTruthy();
    expect(db.getApp(app.id)?.wake_page_on_panel).toBe(0);
  });

  test("refuses freeze for a nip.io app", async () => {
    ensurePanel();
    const server = freshServer("ineligible-nipio");
    const app = db.insertApp({
      name: `app-nipio-${Date.now()}`,
      domain: "1-2-3-4.nip.io",
      git_repo: "https://x.git",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("nip.io");
    expect(createdSnapshots.length).toBe(0);
    expect(db.getServer(server.id)?.state).toBe("materialized");
  });

  test("refuses freeze for an app with no domain at all", async () => {
    ensurePanel();
    const server = freshServer("ineligible-raw-ip");
    const app = db.insertApp({
      name: `app-raw-${Date.now()}`,
      domain: "",
      git_repo: "https://x.git",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(after?.error).toContain("no domain");
    expect(createdSnapshots.length).toBe(0);
    expect(db.getServer(server.id)?.state).toBe("materialized");
  });

  test("blocks the whole server even if only one of several apps is ineligible", async () => {
    ensurePanel();
    const server = freshServer("ineligible-mixed");
    const goodApp = freshApp(`app-good-${Date.now()}`);
    withDnsRecord(goodApp);
    stoppedAnchor(goodApp.id, server.id, 10000, goodApp.name);

    const badApp = freshApp(`app-bad-${Date.now()}`);
    // No DNS record for badApp.
    stoppedAnchor(badApp.id, server.id, 10001, badApp.name);

    const job = db.enqueueFreezeJob(server.id);
    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("failed");
    expect(createdSnapshots.length).toBe(0);
    // Neither app's panel flag was touched.
    expect(db.getApp(goodApp.id)?.wake_page_on_panel).toBe(0);
    expect(db.getApp(badApp.id)?.wake_page_on_panel).toBe(0);
  });
});

describe("snapshot resume after panel restart", () => {
  // Simulates the worker crashing mid-`snapshotting` and a fresh panel
  // process picking up the same job row. The job's snapshot_id is already
  // set, so the worker must re-attach to the existing snapshot rather than
  // calling snapshots.create() again (which would leak the original).
  beforeEach(() => {
    resetProviderState();
    db.deletePanel();
  });

  test("re-attaches to an in-flight snapshot instead of creating a new one", async () => {
    ensurePanel();
    const server = freshServer("resume");
    const app = freshApp(`app-resume-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);
    db.updateAppSleepingState(app.id, server.id, 10000, "tok-resume");

    // Pre-seed: simulate a prior worker run that issued snapshots.create
    // and persisted the result to the job row, then crashed. The provider
    // still has the snapshot in its `available` state.
    const orphanSnapshotId = "snap-from-prior-run";
    snapshotStates.set(orphanSnapshotId, "available");

    const job = db.enqueueFreezeJob(server.id);
    db.updateFreezeJobState(job.id, "snapshotting", { snapshot_id: orphanSnapshotId });

    await _runFreezeJobForTest(job.id);

    // Critical assertion: no NEW snapshot was created. The worker resumed.
    expect(createdSnapshots.length).toBe(0);

    // Freeze still completed end-to-end with the prior snapshot.
    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("done");
    expect(after?.snapshot_id).toBe(orphanSnapshotId);

    const srv = db.getServer(server.id);
    expect(srv?.state).toBe("frozen");
    expect(srv?.snapshot_id).toBe(orphanSnapshotId);
    expect(deletedServers.length).toBe(1);
  });

  test("creates fresh snapshot when the prior id is no longer on the provider", async () => {
    ensurePanel();
    const server = freshServer("resume-stale");
    const app = freshApp(`app-stale-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);

    const staleSnapshotId = "snap-stale";
    // Don't seed snapshotStates — fakeProvider.get returns "creating" for
    // unknown ids, which counts as still-alive in the resume check. To
    // exercise the "stale, recreate" branch we need .get to actually fail.
    onGetSnapshot = (id) => {
      if (id === staleSnapshotId) {
        throw new Error("not found");
      }
    };

    const job = db.enqueueFreezeJob(server.id);
    db.updateFreezeJobState(job.id, "snapshotting", { snapshot_id: staleSnapshotId });

    await _runFreezeJobForTest(job.id);

    // A fresh snapshot was created (the prior was unreachable).
    expect(createdSnapshots.length).toBe(1);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("done");
    expect(after?.snapshot_id).toBe(createdSnapshots[0]);
    // The fresh snapshot's id is what landed on the server row.
    expect(db.getServer(server.id)?.snapshot_id).toBe(createdSnapshots[0]);
  });

  test("resume skips the quota guard so a near-cap restart still completes", async () => {
    ensurePanel();
    const server = freshServer("resume-quota");
    const app = freshApp(`app-rq-${Date.now()}`);
    withDnsRecord(app);
    stoppedAnchor(app.id, server.id, 10000, app.name);

    // Set quota to 1 and put one snapshot in the listing — a fresh freeze
    // would be refused, but a resume should bypass the guard since it
    // already holds its slot.
    _setTimingsForTest({ quotaLimit: 1 });
    existingSnapshots = ["existing-1"];

    const orphanSnapshotId = "snap-resume-near-cap";
    snapshotStates.set(orphanSnapshotId, "available");

    const job = db.enqueueFreezeJob(server.id);
    db.updateFreezeJobState(job.id, "snapshotting", { snapshot_id: orphanSnapshotId });

    await _runFreezeJobForTest(job.id);

    const after = db.getFreezeJob(job.id);
    expect(after?.state).toBe("done");
    expect(createdSnapshots.length).toBe(0);
    expect(db.getServer(server.id)?.state).toBe("frozen");

    _setTimingsForTest({ quotaLimit: 95 });
  });
});
