import { beforeEach, describe, expect, mock, test } from "bun:test";
import { randomSuffix, useTempDataDir } from "../shared/test-helpers.ts";

useTempDataDir();

const deleteServer = mock(async (_id: string) => {});
const fakeProvider = { deleteServer };

import * as db from "../shared/db.ts";
const { reconcileServerGc } = await import("./infrastructure-reconciler.ts");

function makeServer() {
  return db.insertServer({
    name: `gc-${randomSuffix()}`,
    provider_id: `provider-${randomSuffix()}`,
    ipv4: "203.0.113.1",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
    provider: "hetzner",
    ownership: "managed",
  });
}

describe("infrastructure reconciliation", () => {
  beforeEach(() => {
    deleteServer.mockClear();
    deleteServer.mockImplementation(async () => {});
    db.deletePanel();
  });

  test("keeps the DB row and retries when provider server deletion fails", async () => {
    const server = makeServer();
    db.requestServerGc(server.id);
    deleteServer.mockImplementationOnce(async () => { throw new Error("provider unavailable"); });

    await reconcileServerGc(fakeProvider);
    expect(db.getServer(server.id)).toBeTruthy();
    expect(db.getServer(server.id)?.gc_requested_at).toBeTruthy();

    await reconcileServerGc(fakeProvider);
    expect(deleteServer).toHaveBeenCalledTimes(2);
    expect(db.getServer(server.id)).toBeNull();
  });

  test("cancels stale GC intent when a service now references the server", async () => {
    const server = makeServer();
    db.requestServerGc(server.id);
    const service = db.insertService({
      name: `service-${randomSuffix()}`,
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

    await reconcileServerGc(fakeProvider);

    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)?.gc_requested_at).toBeNull();
  });

  test("disconnects an unreferenced external server without provider deletion", async () => {
    const server = db.insertServer({
      name: `connected-${randomSuffix()}`,
      provider_id: "",
      provider: "external",
      ownership: "connected",
      ipv4: "203.0.113.2",
      ipv6: "",
      private_ipv4: "10.0.0.2",
      type: "external",
      location: "external",
      status: "ready",
    });
    db.requestServerGc(server.id);
    await reconcileServerGc(fakeProvider);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)).toBeNull();
  });
});
