import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";

function makeServer() {
  return db.insertServer({
    name: `port-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "203.0.113.20",
    private_ipv4: "10.0.0.20",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

describe("transactional host-port reservations", () => {
  test("serializes the complete bind tuple and releases it for rollback", () => {
    const server = makeServer();
    const first = db.reserveHostPort({
      serverId: server.id,
      bindAddress: server.private_ipv4,
      hostPort: 10008,
      ownerType: "migration",
      ownerId: "op:1",
    });

    expect(() => db.reserveHostPort({
      serverId: server.id,
      bindAddress: server.private_ipv4,
      hostPort: 10008,
      ownerType: "migration",
      ownerId: "op:2",
    })).toThrow(/already reserved.*migration:op:1/i);

    db.releaseHostPortReservation(first.id);
    const retry = db.reserveHostPort({
      serverId: server.id,
      bindAddress: server.private_ipv4,
      hostPort: 10008,
      ownerType: "migration",
      ownerId: "op:2",
    });
    expect(retry.owner_id).toBe("op:2");
    db.releaseHostPortReservation(retry.id);
  });

  test("rejects a tuple already represented by a live replica before transfer", () => {
    const server = makeServer();
    const app = db.insertApp({
      name: `app-${randomSuffix()}`,
      domain: "",
      image_ref: `ghcr.io/acme/test@sha256:${"a".repeat(64)}`,
      container_port: 3000,
      env_vars: "{}",
      public: false,
    });
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 10009,
      container_name: app.name,
      status: "running",
    });

    expect(() => db.reserveHostPort({
      serverId: server.id,
      bindAddress: server.private_ipv4,
      hostPort: 10009,
      ownerType: "migration",
      ownerId: "op:3",
    })).toThrow(/reserved by replica/i);
  });
});
