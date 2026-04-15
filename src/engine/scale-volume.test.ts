// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-scale-volume-test-"));

import { describe, test, expect, mock } from "bun:test";

// Mock providers so any stray call errors cleanly instead of hitting the
// network. We should never reach these in the volume-rejection tests.
const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  deleteServer: mock(async () => { throw new Error("unexpected deleteServer"); }),
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

import * as db from "../shared/db.ts";
import { scaleApp } from "./scale-api.ts";

function freshServer(suffix: string) {
  return db.insertServer({
    name: `srv-${suffix}`,
    provider_id: `h-${suffix}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
}

function freshApp(name: string): db.AppRow {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

describe("scaleApp volume guard", () => {
  test("rejects target > 1 when the app has a volume attached", async () => {
    const server = freshServer("vol-reject");
    const app = freshApp(`app-vol-reject-${Date.now()}`);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    // Simulate a volume attach.
    db.updateAppVolume(app.id, "vol-123", "/mnt/data:/data");

    const result = await scaleApp(app.id, 2);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("persistent storage");

    // Replica count unchanged.
    expect(db.getReplicas(app.id).length).toBe(1);
  });

  test("allows target = 1 (no-op same count) for volume apps", async () => {
    const server = freshServer("vol-same");
    const app = freshApp(`app-vol-same-${Date.now()}`);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10001,
      container_name: app.name,
      status: "running",
    });
    db.updateAppVolume(app.id, "vol-456", "/mnt/data:/data");

    const result = await scaleApp(app.id, 1);
    expect(result.ok).toBe(true);
  });

  test("allows target = 0 (sleep) for volume apps — volume stays attached to the single server", async () => {
    const app = freshApp(`app-vol-sleep-${Date.now()}`);
    db.updateAppVolume(app.id, "vol-789", "/mnt/data:/data");
    // Simulating scale-to-zero path requires SSH — we just assert the guard
    // does not fire for targetReplicas=0 by reading what the guard checks.
    // The guard is `app.volume_id && targetReplicas > 1`, so 0 is allowed.
    // We inspect this by going from 0 to 0 (no-op short-circuit path).
    const result = await scaleApp(app.id, 0);
    expect(result.ok).toBe(true);
  });
});
