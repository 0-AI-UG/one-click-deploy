import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";

const compute = makeFakeComputeProvider();
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));
mock.module("../../shared/remote/index.ts", () => ({
  getOrCreateLocalKeyPair: mock(async () => ({ publicKey: "ssh-ed25519 test" })),
  waitForServer: mock(async () => {}),
  captureHostKey: mock(async () => "host-key"),
  sshExec: mock(async () => ({ exitCode: 0, stdout: "Docker version test", stderr: "" })),
}));
mock.module("../network.ts", () => ({ ensureNetwork: mock(async () => "net-1") }));

import * as db from "../../shared/db.ts";
import provisionServerOp from "./provision-server.ts";

function ctx(input: Record<string, unknown>, opId = 73) {
  return {
    opId,
    kind: "provision_server",
    input,
    trigger: "ui",
    triggeredBy: "",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  } as any;
}

function step(name: string) {
  const found = provisionServerOp.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`step ${name} not found`);
  return found;
}

beforeEach(() => {
  compute._mocks.createServer.mockClear();
  compute._mocks.getServer.mockClear();
  compute.listServers = async () => [];
});

describe("provision_server crash identity", () => {
  test("uses an operation-derived name and reuses its placeholder row", async () => {
    const input = { serverType: "cx22", location: "fsn1", pool: "build-workers" };
    const first = await step("insert_server_row").run(ctx(input), {} as any) as any;
    const second = await step("insert_server_row").run(ctx(input), {} as any) as any;
    expect(first.serverName).toBe("ocd-server-op73");
    expect(second).toEqual(first);
    expect(db.getServers().filter((server) => server.name === first.serverName)).toHaveLength(1);
    expect(db.getServer(first.serverId)?.pool).toBe("build-workers");
  });

  test("adopts a provider server created before the DB provider id was saved", async () => {
    const serverName = `adopt-${randomSuffix()}`;
    const row = db.insertServer({
      name: serverName,
      provider_id: "",
      ipv4: "",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "creating",
    });
    compute.listServers = async () => [{
      providerId: "h-adopted",
      name: serverName,
      ipv4: "10.0.0.9",
      ipv6: "",
      status: "running",
      type: "",
      location: "",
    }];
    compute._mocks.getServer.mockImplementation(async () => ({
      providerId: "h-adopted",
      ipv4: "10.0.0.9",
      ipv6: "",
      privateIpv4: "10.1.0.9",
      status: "running",
    }));

    const out = await step("create_cloud_server").probe!(
      ctx({ serverType: "cx22", location: "fsn1", name: serverName }),
      { insert_server_row: { serverId: row.id, serverName } },
    ) as any;

    expect(out.providerId).toBe("h-adopted");
    expect(db.getServer(row.id)).toMatchObject({
      provider_id: "h-adopted",
      ipv4: "10.0.0.9",
      private_ipv4: "10.1.0.9",
      status: "provisioning",
    });
    expect(compute._mocks.createServer).not.toHaveBeenCalled();
  });

  test("does not create when provider identity cannot be listed", async () => {
    const serverName = `unknown-${randomSuffix()}`;
    const row = db.insertServer({
      name: serverName,
      provider_id: "",
      ipv4: "",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "creating",
    });
    compute.listServers = async () => { throw new Error("provider unavailable"); };
    await expect(step("create_cloud_server").run(
      ctx({ serverType: "cx22", location: "fsn1", name: serverName }),
      {
        ensure_infra: { sshKeyName: "key", firewallId: "fw", networkId: "net" },
        insert_server_row: { serverId: row.id, serverName },
      },
    )).rejects.toThrow("provider unavailable");
    expect(compute._mocks.createServer).not.toHaveBeenCalled();
  });
});
