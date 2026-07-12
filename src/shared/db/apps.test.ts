import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../db.ts";
import {
  INTERNAL_PORT_BASE,
  INTERNAL_PORT_COUNT,
  PUBLIC_TCP_PORT_BASE,
  PUBLIC_TCP_PORT_COUNT,
  PUBLIC_UDP_PORT_BASE,
  PUBLIC_UDP_PORT_COUNT,
  type PublicProtocol,
} from "./apps.ts";

function makeApp(
  name = `app-${randomSuffix()}`,
  extra: { public_port?: number | "auto" | null; public_protocol?: PublicProtocol } = {},
) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    ...extra,
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

describe("public port allocation (raw TCP/UDP exposure)", () => {
  function lowestFreePublicPort(protocol: PublicProtocol): number {
    const base = protocol === "udp" ? PUBLIC_UDP_PORT_BASE : PUBLIC_TCP_PORT_BASE;
    const used = new Set(db.getApps().map((a) => a.public_port));
    for (let p = base; ; p++) if (!used.has(p)) return p;
  }

  test("apps are unexposed by default", () => {
    const a = makeApp();
    expect(a.public_port).toBeNull();
    expect(a.public_protocol).toBe("tcp");
    db.deleteApp(a.id);
  });

  test('"auto" allocates the lowest free port in the protocol\'s block', () => {
    const expectedTcp = lowestFreePublicPort("tcp");
    const a = makeApp(undefined, { public_port: "auto" });
    expect(a.public_port).toBe(expectedTcp);
    expect(a.public_protocol).toBe("tcp");

    const expectedUdp = lowestFreePublicPort("udp");
    const b = makeApp(undefined, { public_port: "auto", public_protocol: "udp" });
    expect(b.public_port).toBe(expectedUdp);
    expect(b.public_protocol).toBe("udp");
    expect(b.public_port).toBeGreaterThanOrEqual(PUBLIC_UDP_PORT_BASE);
    expect(b.public_port!).toBeLessThan(PUBLIC_UDP_PORT_BASE + PUBLIC_UDP_PORT_COUNT);

    // Deleting an app frees its port for the next allocation.
    db.deleteApp(a.id);
    const c = makeApp(undefined, { public_port: "auto" });
    expect(c.public_port).toBe(expectedTcp);
    db.deleteApp(b.id);
    db.deleteApp(c.id);
  });

  test("a specific port must be free and inside the protocol's range", () => {
    const port = lowestFreePublicPort("tcp");
    const a = makeApp(undefined, { public_port: port });
    expect(a.public_port).toBe(port);
    // Conflict with an existing app.
    expect(() => makeApp(undefined, { public_port: port })).toThrow(/already taken/);
    // Out of range for the protocol (UDP port in the TCP block and vice versa).
    expect(() => makeApp(undefined, { public_port: PUBLIC_UDP_PORT_BASE })).toThrow(/ports are/);
    expect(() =>
      makeApp(undefined, { public_port: PUBLIC_TCP_PORT_BASE, public_protocol: "udp" }),
    ).toThrow(/ports are/);
    expect(() => makeApp(undefined, { public_port: 8080 })).toThrow(/ports are/);
    db.deleteApp(a.id);
  });

  test("updateAppPublicExposure exposes and unexposes post-insert", () => {
    const a = makeApp();
    const port = lowestFreePublicPort("udp");
    db.updateAppPublicExposure(a.id, port, "udp");
    const exposed = db.getApp(a.id)!;
    expect(exposed.public_port).toBe(port);
    expect(exposed.public_protocol).toBe("udp");
    expect(db.getAppByPublicPort(port)?.id).toBe(a.id);

    db.updateAppPublicExposure(a.id, null, "udp");
    expect(db.getApp(a.id)!.public_port).toBeNull();
    expect(db.getAppByPublicPort(port)).toBeNull();
    db.deleteApp(a.id);
  });

  test("the partial unique index rejects duplicate public_port writes", () => {
    const port = lowestFreePublicPort("tcp");
    const a = makeApp(undefined, { public_port: port });
    const b = makeApp();
    expect(() => db.updateAppPublicExposure(b.id, port, "tcp")).toThrow();
    db.deleteApp(a.id);
    db.deleteApp(b.id);
  });

  test("allocation exhausts with a clear error when the block is full", () => {
    // Claim every UDP port not already taken, then expect a clear failure.
    const fillers: number[] = [];
    try {
      for (;;) {
        const next = lowestFreePublicPort("udp");
        if (next >= PUBLIC_UDP_PORT_BASE + PUBLIC_UDP_PORT_COUNT) break;
        fillers.push(makeApp(undefined, { public_port: next, public_protocol: "udp" }).id);
      }
      expect(() => makeApp(undefined, { public_port: "auto", public_protocol: "udp" }))
        .toThrow(/public UDP ports .* are taken/);
    } finally {
      for (const id of fillers) db.deleteApp(id);
    }
  });
});

describe("parseExtraVolumes", () => {
  test("parses a JSON array of host:container specs", () => {
    expect(db.parseExtraVolumes('["/home/deploy/apps/x/v:/data","/mnt/ocd-y:/y"]'))
      .toEqual(["/home/deploy/apps/x/v:/data", "/mnt/ocd-y:/y"]);
  });

  test("returns [] for empty / null / undefined", () => {
    expect(db.parseExtraVolumes("")).toEqual([]);
    expect(db.parseExtraVolumes(null)).toEqual([]);
    expect(db.parseExtraVolumes(undefined)).toEqual([]);
  });

  test("returns [] for malformed JSON", () => {
    expect(db.parseExtraVolumes("not json")).toEqual([]);
    expect(db.parseExtraVolumes("{}")).toEqual([]); // object, not array
  });

  test("filters out non-string entries", () => {
    expect(db.parseExtraVolumes('["/a:/a", 42, null, {"x":1}, "/b:/b"]'))
      .toEqual(["/a:/a", "/b:/b"]);
  });
});
