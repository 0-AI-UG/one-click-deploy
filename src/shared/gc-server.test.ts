// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the provider BEFORE importing db.ts so the dynamic import in
// gcServerIfEmpty resolves to the mock.
const deleteServer = mock(async (_id: string) => {});
const fakeProvider = {
  id: "hetzner",
  name: "Hetzner",
  deleteServer,
};
const fakeDnsProvider = { id: "hetzner-dns", name: "Hetzner DNS", listZones: async () => [], createRecord: async () => ({ id: "1", name: "", type: "", value: "" }), deleteRecord: async () => {} };
mock.module("./providers/index.ts", () => ({
  hetzner: fakeProvider,
  hetznerDns: fakeDnsProvider,
}));

import * as db from "./db.ts";

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

describe("gcServerIfEmpty", () => {
  beforeEach(() => {
    deleteServer.mockClear();
    db.deletePanel();
  });

  test("records durable GC intent for a non-panel empty server", async () => {
    const server = freshServer("empty");
    await db.gcServerIfEmpty(server.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)?.gc_requested_at).toBeTruthy();
  });

  test("does NOT delete the panel's server even when empty", async () => {
    const server = freshServer("panelhost");
    db.insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      git_repo: "https://github.com/x/one-click-deploy",
      container_port: 3000,
      host_port: 10000,
    });
    await db.gcServerIfEmpty(server.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)).toBeTruthy();
    db.deletePanel();
  });

  test("does NOT delete a server that still has replicas", async () => {
    const server = freshServer("withreplica");
    // Need an app to satisfy FK on replicas
    const app = db.insertApp({
      name: `app-${Date.now()}`,
      domain: "x.com",
      git_repo: "https://x.git",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
    });
    await db.gcServerIfEmpty(server.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)).toBeTruthy();
  });

  test("does NOT delete a server whose only replica is status=stopped (light sleep anchor)", async () => {
    const server = freshServer("lightsleep");
    const app = db.insertApp({
      name: `app-sleep-${Date.now()}`,
      domain: "x.com",
      git_repo: "https://x.git",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const replica = db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
    });
    db.markReplicaStopped(replica.id);
    // The stopped replica should keep the server alive (light sleep) and
    // hasRunningReplicas should report false, hasAnyReplicas true.
    expect(db.hasRunningReplicas(server.id)).toBe(false);
    expect(db.hasAnyReplicas(server.id)).toBe(true);

    await db.gcServerIfEmpty(server.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)).toBeTruthy();
  });

  test("does NOT request GC while a service instance references the server", async () => {
    const server = freshServer("withservice");
    const service = db.insertService({
      name: `service-${Date.now()}`,
      service_type: "postgres",
      version: "16",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: service.name,
      host_port: 15000,
    });
    await db.gcServerIfEmpty(server.id);
    expect(db.getServer(server.id)?.gc_requested_at).toBeNull();
  });

  test("markReplicaStopped sets stopped_at and markReplicaRunning clears it", () => {
    const server = freshServer("toggle");
    const app = db.insertApp({
      name: `app-toggle-${Date.now()}`,
      domain: "x.com",
      git_repo: "https://x.git",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const replica = db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    db.markReplicaStopped(replica.id);
    const after1 = db.getReplica(replica.id);
    expect(after1?.status).toBe("stopped");
    expect(after1?.stopped_at).toBeTruthy();

    db.markReplicaRunning(replica.id);
    const after2 = db.getReplica(replica.id);
    expect(after2?.status).toBe("running");
    expect(after2?.stopped_at).toBeNull();
  });
});
