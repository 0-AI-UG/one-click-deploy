import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const compute = makeFakeComputeProvider();
mock.module("../../shared/providers/index.ts", () => ({
  hetzner: compute,
  hetznerDns: ({
    id: "x",
    name: "x",
    listZones: async () => [],
    createRecord: async () => ({ id: "", name: "", type: "", value: "" }),
    deleteRecord: async () => {},
  }),
}));

const sshExec = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
mock.module("../../shared/remote/index.ts", () => ({
  sshExec,
  restartContainer: mock(async () => {}),
  serviceHealthCheck: mock(async () => ({ healthy: true })),
  pauseContainer: mock(async () => {}),
  unpauseContainer: mock(async () => {}),
  getContainerLogs: mock(async () => ""),
}));

import * as db from "../../shared/db.ts";
import { destroyServiceCore as destroyService } from "./service-lifecycle.ts";

function freshServer() {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function freshService() {
  return db.insertService({
    name: `svc-${randomSuffix()}`,
    service_type: "postgres",
    version: "16",
    port: 5432,
    env_vars: "{}",
    credentials: "{}",
  });
}

beforeEach(() => {
  sshExec.mockClear();
  compute._mocks.volumeDelete.mockClear();
  sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  compute._mocks.volumeDelete.mockImplementation(async () => {});
});

describe("destroyService", () => {
  test("removes container, deletes volume, and removes DB rows on success", async () => {
    const server = freshServer();
    const service = freshService();
    const inst = db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `svc-${service.id}-primary`,
      host_port: 15432,
      volume_id: "v-abc",
      volume_mount: "/var/lib/postgresql/data",
    });

    const result = await destroyService(service.id);

    expect(result.ok).toBe(true);
    expect(sshExec).toHaveBeenCalled();
    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete.mock.calls[0][0]).toBe("v-abc");
    expect(db.getService(service.id)).toBeNull();
    expect(db.getServiceInstance(inst.id)).toBeNull();
  });

  test("returns error for unknown service id", async () => {
    const result = await destroyService(999_999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test("does not attempt volume delete when instance has no volume", async () => {
    const server = freshServer();
    const service = freshService();
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `svc-${service.id}`,
      host_port: 15433,
    });
    const result = await destroyService(service.id);
    expect(result.ok).toBe(true);
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
  });

  test("marks service cleanup_failed when container removal fails", async () => {
    const server = freshServer();
    const service = freshService();
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `svc-${service.id}`,
      host_port: 15434,
    });
    sshExec.mockImplementationOnce(async () => { throw new Error("unreachable"); });

    const result = await destroyService(service.id);

    expect(result.ok).toBe(false);
    expect(db.getService(service.id)?.status).toBe("cleanup_failed");
  });

  test("marks service cleanup_failed when volume delete fails", async () => {
    const server = freshServer();
    const service = freshService();
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `svc-${service.id}`,
      host_port: 15435,
      volume_id: "v-err",
    });
    compute._mocks.volumeDelete.mockImplementationOnce(async () => { throw new Error("still attached"); });

    const result = await destroyService(service.id);

    expect(result.ok).toBe(false);
    expect(db.getService(service.id)?.status).toBe("cleanup_failed");
    // Even in failure, the instance row is deleted in this lifecycle (note: it
    // happens BEFORE the cleanupFailed short-circuit). This test pins the
    // current behaviour so future refactors are explicit.
    const remaining = db.getServiceInstances(service.id);
    expect(remaining).toEqual([]);
  });

  test("strips linked-app env vars with the matching prefix on destroy", async () => {
    const env = db.insertEnvironment(
      `env-${randomSuffix()}`,
      JSON.stringify({
        version: 2,
        entries: [
          { key: "DATABASE_URL", value: "postgres://...", secret: false, updated_at: "now" },
          { key: "DATABASE_HOST", value: "1.2.3.4", secret: false, updated_at: "now" },
          { key: "OTHER_TOKEN", value: "keep", secret: false, updated_at: "now" },
        ],
      }),
    );
    const server = freshServer();
    const service = freshService();
    db.insertServiceLink(service.id, env.id, "DATABASE");
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `svc-${service.id}`,
      host_port: 15436,
    });

    await destroyService(service.id);

    const updated = db.getEnvironment(env.id);
    const parsed = JSON.parse(updated!.env_vars) as { entries: Array<{ key: string }> };
    expect(parsed.entries.map((e) => e.key)).toEqual(["OTHER_TOKEN"]);
  });
});
