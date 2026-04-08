// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock hetzner BEFORE importing db.ts so the dynamic import in
// gcServerIfEmpty resolves to the mock.
const deleteHetznerServer = mock(async (_id: string) => {});
mock.module("./hetzner/index.ts", () => ({
  deleteHetznerServer,
}));

import * as db from "./db.ts";

function freshServer(name: string) {
  return db.insertServer({
    name,
    hetzner_id: `h-${name}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
}

describe("gcServerIfEmpty", () => {
  beforeEach(() => {
    deleteHetznerServer.mockClear();
    db.deletePanel();
  });

  test("deletes a non-panel empty server", async () => {
    const server = freshServer("empty");
    await db.gcServerIfEmpty(server.id);
    expect(deleteHetznerServer).toHaveBeenCalledTimes(1);
    expect(db.getServer(server.id)).toBeFalsy();
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
    expect(deleteHetznerServer).not.toHaveBeenCalled();
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
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)).toBeTruthy();
  });
});
