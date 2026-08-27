// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-scale-volume-test-"));

import { describe, test, expect } from "bun:test";

// The volume cap short-circuits inside convergence (desired is clamped to the
// current count of 1) before any provider or SSH call, so no network mocks are
// needed — and mock.module is process-global in Bun, so adding them here would
// leak into sibling test files.
import * as db from "../shared/db.ts";
import { convergeAppReplicas } from "./scale/index.ts";

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
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
}

// A cloud volume attaches to exactly one server, so a volume app is hard capped
// at one replica. Convergence enforces this by clamping desired_replicas to 1 —
// so even a desired count of 2 is a no-op that never touches SSH.
describe("convergence volume cap", () => {
  test("desired > 1 on a volume app never adds a second replica", async () => {
    const server = freshServer("vol-cap");
    const app = freshApp(`app-vol-cap-${Date.now()}`);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10000,
      container_name: app.name,
      status: "running",
    });
    db.updateAppVolume(app.id, "vol-123", "/mnt/data:/data");
    // A stale/over-eager desired count that the cap must defuse.
    db.updateAppScaling(app.id, { desired_replicas: 2 });

    await convergeAppReplicas(app.id);

    // Capped at 1 — no scale-up, no SSH (the remote mocks would have thrown).
    expect(db.getReplicas(app.id).length).toBe(1);
  });

  test("desired = 1 on a volume app is a no-op", async () => {
    const server = freshServer("vol-noop");
    const app = freshApp(`app-vol-noop-${Date.now()}`);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10001,
      container_name: app.name,
      status: "running",
    });
    db.updateAppVolume(app.id, "vol-456", "/mnt/data:/data");
    db.updateAppScaling(app.id, { desired_replicas: 1 });

    await convergeAppReplicas(app.id);

    expect(db.getReplicas(app.id).length).toBe(1);
  });
});
