import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../db.ts";
import { INTERNAL_PORT_BASE, INTERNAL_PORT_COUNT } from "./apps.ts";

function makeApp(name = `app-${randomSuffix()}`) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

// The db module (and its temp data dir) is shared across all test files in
// the bun test process, so assertions are relative to the current state
// rather than assuming an empty apps table.
function lowestFreePort(): number {
  const used = new Set(db.getApps().map((a) => a.internal_port));
  for (let p = INTERNAL_PORT_BASE; ; p++) if (!used.has(p)) return p;
}

describe("internal port allocation", () => {
  test("insertApp allocates the lowest free port in the block", () => {
    const expected = lowestFreePort();
    const a = makeApp();
    expect(a.internal_port).toBe(expected);
    expect(a.internal_port).toBeGreaterThanOrEqual(INTERNAL_PORT_BASE);
    expect(a.internal_port).toBeLessThan(INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT);
  });

  test("allocation fills the lowest gap left by a deleted app", () => {
    const a = makeApp();
    const b = makeApp();
    expect(b.internal_port).toBeGreaterThan(a.internal_port);
    db.deleteApp(a.id);
    const c = makeApp();
    expect(c.internal_port).toBe(a.internal_port);
  });

  test("insertAppWithFirstReplica allocates a port; replica delete/re-add keeps it", () => {
    const server = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "1.2.3.4",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const name = `app-${randomSuffix()}`;
    const { app, replica } = db.insertAppWithFirstReplica(
      {
        name,
        domain: `${name}.example.com`,
        git_repo: "https://github.com/x/y",
        dockerfile_path: "Dockerfile",
        container_port: 3000,
        env_vars: "{}",
      },
      server.id,
    );
    expect(app.internal_port).toBeGreaterThanOrEqual(INTERNAL_PORT_BASE);

    db.deleteReplica(replica.id);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: replica.host_port,
      container_name: name,
    });
    // The port lives on the app row — replica churn never reallocates it.
    expect(db.getApp(app.id)!.internal_port).toBe(app.internal_port);
    const next = makeApp();
    expect(next.internal_port).not.toBe(app.internal_port);
  });

  test("countApps tracks inserts and deletes", () => {
    const before = db.countApps();
    const a = makeApp();
    expect(db.countApps()).toBe(before + 1);
    db.deleteApp(a.id);
    expect(db.countApps()).toBe(before);
  });

  test("throws a clear error when all 200 ports are taken", () => {
    const fillers: number[] = [];
    try {
      while (db.countApps() < INTERNAL_PORT_COUNT) fillers.push(makeApp().id);
      expect(db.countApps()).toBe(INTERNAL_PORT_COUNT);
      expect(() => makeApp()).toThrow(/Fleet limit of 200 apps/);
    } finally {
      // Free the block again — later test files share this db.
      for (const id of fillers) db.deleteApp(id);
    }
  });
});
