import { useTempDataDir, makeFakeComputeProvider, makeFakeDnsProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Providers must be mocked before importing deploy.ts (static imports).
const compute = makeFakeComputeProvider();
const dns = makeFakeDnsProvider();
mock.module("../../shared/providers/index.ts", () => ({
  hetzner: compute,
  hetznerDns: dns,
}));

// provisionServer is only called when no ready server exists. Stub it.
const provisionServer = mock(async (opts: { name: string }) => ({
  id: 12345,
  provider_id: `h-${opts.name}`,
  ipv4: "5.5.5.5",
  ssh_host_key: "",
}));
mock.module("../provision-server.ts", () => ({ provisionServer }));

// Stub all remote + ingress + github + other deep deps so deploy.ts at least
// imports cleanly even though we're only exercising selected steps.
const healthCheckMock = mock(async () => ({ healthy: true, statusCode: 200 }));
const containerRunningCheckMock = mock(async () => ({ healthy: true }));
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  cloneAndBuild: mock(async () => {}),
  removeContainer: mock(async () => {}),
  healthCheck: healthCheckMock,
  containerRunningCheck: containerRunningCheckMock,
}));
mock.module("../scale/traefik-manager.ts", () => ({
  syncAppIngress: mock(async () => {}),
  getPanelIngressIpv4: mock(() => null),
  syncAllTraefik: mock(async () => {}),
  reconcileTraefik: mock(async () => {}),
}));
mock.module("../scale/index.ts", () => ({
  rollingRedeploy: mock(async () => ({ ok: true })),
}));
mock.module("../../shared/github.ts", () => ({
  getGitHubPat: async () => null,
  deleteWebhook: async () => {},
  createWebhookAtUrl: async () => ({ id: 1 }),
}));

import * as db from "../../shared/db.ts";
import deployOp, { resolveAppDomain } from "./deploy.ts";
import redeployOp from "./redeploy.ts";

// Synthetic op context. Steps that don't call park/unpark can use this shape.
function makeCtx(input: any) {
  const logLines: string[] = [];
  return {
    ctx: {
      opId: 1,
      kind: "deploy",
      input,
      trigger: "user" as const,
      triggeredBy: "",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: (line: string) => logLines.push(line),
      park: () => {},
      unpark: () => {},
    } as any,
    logLines,
  };
}

function stepByName(name: string) {
  const step = deployOp.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
}

beforeEach(() => {
  provisionServer.mockClear();
  dns._mocks.createRecord.mockClear();
  dns._mocks.deleteRecord.mockClear();
  compute._mocks.volumeCreate.mockClear();
  compute._mocks.volumeDelete.mockClear();
  healthCheckMock.mockClear();
  containerRunningCheckMock.mockClear();
});

const baseReq = (name: string) => ({
  app_name: name,
  git_repo: "https://github.com/x/y",
  container_port: 3000,
  domain: "example.com",
});

describe("deploy step: pick_or_provision_server", () => {
  const step = stepByName("pick_or_provision_server");

  test("rejects a duplicate app name", async () => {
    const name = `dup-${randomSuffix()}`;
    db.insertApp({
      name,
      domain: "x.example.com",
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const { ctx } = makeCtx(baseReq(name));
    expect(step.run(ctx, {})).rejects.toThrow(/already exists/i);
  });

  test("propagates validation error from validateDeployRequest", async () => {
    const { ctx } = makeCtx({ ...baseReq("valid"), app_name: "Bad Name" });
    expect(step.run(ctx, {})).rejects.toThrow();
  });

  test("reuses an existing ready server when no server_id is specified", async () => {
    for (const s of db.getServers()) db.deleteServer(s.id);
    const existing = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "9.9.9.9",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const { ctx } = makeCtx(baseReq(`app-${randomSuffix()}`));
    const out = (await step.run(ctx, {})) as { serverId: number; serverIp: string; provisioned: boolean };
    expect(out.serverId).toBe(existing.id);
    expect(out.serverIp).toBe("9.9.9.9");
    expect(out.provisioned).toBe(false);
    expect(provisionServer).not.toHaveBeenCalled();
  });

  test("rejects an invalid server_id target", async () => {
    const { ctx } = makeCtx({ ...baseReq(`app-${randomSuffix()}`), server_id: 987654 });
    expect(step.run(ctx, {})).rejects.toThrow(/not found|not ready/i);
  });

  test("rejects a server_id target that is not status=ready", async () => {
    const notReady = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "1.1.1.1",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "provisioning",
    });
    const { ctx } = makeCtx({ ...baseReq(`app-${randomSuffix()}`), server_id: notReady.id });
    expect(step.run(ctx, {})).rejects.toThrow(/not found|not ready/i);
  });

  test("provisions a new server when none exist and settings are valid", async () => {
    // Clear all existing servers first.
    const srvs = db.getServers();
    for (const s of srvs) db.deleteServer(s.id);
    db.saveSetting("default_server_type", "cx22");
    db.saveSetting("default_location", "fsn1");

    const { ctx } = makeCtx(baseReq(`app-${randomSuffix()}`));
    const out = (await step.run(ctx, {})) as { provisioned: boolean; serverIp: string };
    expect(provisionServer).toHaveBeenCalledTimes(1);
    expect(out.provisioned).toBe(true);
    expect(out.serverIp).toBe("5.5.5.5");
  });

  test("requires default_server_type before provisioning", async () => {
    const srvs = db.getServers();
    for (const s of srvs) db.deleteServer(s.id);
    db.saveSetting("default_server_type", "");
    const { ctx } = makeCtx(baseReq(`app-${randomSuffix()}`));
    expect(step.run(ctx, {})).rejects.toThrow(/server type/i);
  });

  test("lazily resolves and caches the zone name for auto-domain deploys", async () => {
    for (const s of db.getServers()) db.deleteServer(s.id);
    db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "9.9.9.8",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    try {
      // Zone id configured but the name was never resolved.
      db.saveSetting("dns_zone_id", "zone-1"); // fake provider knows zone-1 = example.com
      db.saveSetting("dns_zone_name", "");
      const { ctx } = makeCtx({ app_name: `auto-${randomSuffix()}`, git_repo: "https://github.com/x/y", container_port: 3000 });
      const out = (await step.run(ctx, {})) as { zoneName?: string };
      expect(out.zoneName).toBe("example.com");
      expect(db.getSettings().dns_zone_name).toBe("example.com");

      // Deploys with an explicit domain don't need (or record) a zone name.
      const { ctx: ctx2 } = makeCtx(baseReq(`auto-${randomSuffix()}`));
      const out2 = (await step.run(ctx2, {})) as { zoneName?: string };
      expect(out2.zoneName).toBe("");
    } finally {
      db.saveSetting("dns_zone_id", "");
      db.saveSetting("dns_zone_name", "");
    }
  });
});

describe("deploy step: create_dns_record", () => {
  const step = stepByName("create_dns_record");

  test("returns null when the request has no domain and no zone is configured", async () => {
    db.saveSetting("dns_zone_id", "");
    db.saveSetting("dns_zone_name", "");
    const { ctx } = makeCtx({ ...baseReq("x"), domain: "" });
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        ingressIp: "1.1.1.1",
      },
    };
    const out = await step.run(ctx, prior);
    expect(out).toBeNull();
    expect(dns._mocks.createRecord).not.toHaveBeenCalled();
  });

  test("returns null when dns_zone_id is unset", async () => {
    db.saveSetting("dns_zone_id", "");
    const { ctx } = makeCtx({ ...baseReq("x"), domain: "app.example.com" });
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        ingressIp: "1.1.1.1",
      },
    };
    const out = await step.run(ctx, prior);
    expect(out).toBeNull();
  });

  test("creates record with @ subdomain for a 2-label domain (example.com)", async () => {
    db.saveSetting("dns_zone_id", "zone-123");
    const { ctx } = makeCtx({ ...baseReq("x"), domain: "example.com" });
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        ingressIp: "4.4.4.4",
      },
    };
    const out = (await step.run(ctx, prior)) as { recordId: string; name: string; value: string };
    expect(out.name).toBe("@");
    expect(out.value).toBe("4.4.4.4");
    expect(dns._mocks.createRecord).toHaveBeenCalledTimes(1);
  });

  test("creates record with subdomain for app.example.com", async () => {
    db.saveSetting("dns_zone_id", "zone-xyz");
    const { ctx } = makeCtx({ ...baseReq("x"), domain: "my.app.example.com" });
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        ingressIp: "7.7.7.7",
      },
    };
    const out = (await step.run(ctx, prior)) as { name: string };
    expect(out.name).toBe("my.app");
    expect(dns._mocks.createRecord.mock.calls[0][0]).toMatchObject({
      zoneId: "zone-xyz",
      name: "my.app",
      type: "A",
      value: "7.7.7.7",
    });
  });

  test("DNS failure is swallowed (best-effort) — returns null", async () => {
    db.saveSetting("dns_zone_id", "zone-ok");
    dns._mocks.createRecord.mockImplementationOnce(async () => {
      throw new Error("dns 500");
    });
    const { ctx, logLines } = makeCtx({ ...baseReq("x"), domain: "app.example.com" });
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        ingressIp: "8.8.8.8",
      },
    };
    const out = await step.run(ctx, prior);
    expect(out).toBeNull();
    expect(logLines.some((l) => /DNS record creation failed/i.test(l))).toBe(true);
  });

  test("auto-domain: creates an A record named after the app", async () => {
    db.saveSetting("dns_zone_id", "zone-auto");
    db.saveSetting("dns_zone_name", "example.com");
    try {
      const { ctx } = makeCtx({ ...baseReq("myapp"), app_name: "myapp", domain: "" });
      const prior = {
        pick_or_provision_server: {
          serverId: 1,
          serverIp: "1.1.1.1",
          serverHostKey: "",
          provisioned: false,
          ingressIp: "6.6.6.6",
          zoneName: "example.com",
        },
      };
      const out = (await step.run(ctx, prior)) as { name: string; value: string; zoneId: string };
      expect(out.name).toBe("myapp");
      expect(out.value).toBe("6.6.6.6");
      expect(dns._mocks.createRecord.mock.calls[0][0]).toMatchObject({
        zoneId: "zone-auto",
        name: "myapp",
        type: "A",
        value: "6.6.6.6",
      });
    } finally {
      db.saveSetting("dns_zone_id", "");
      db.saveSetting("dns_zone_name", "");
    }
  });

  test("no record for the nip.io fallback (zone id set but name unresolved)", async () => {
    db.saveSetting("dns_zone_id", "zone-auto");
    db.saveSetting("dns_zone_name", "");
    try {
      const { ctx } = makeCtx({ ...baseReq("x"), domain: "" });
      const prior = {
        pick_or_provision_server: {
          serverId: 1,
          serverIp: "1.1.1.1",
          serverHostKey: "",
          provisioned: false,
          ingressIp: "6.6.6.6",
          zoneName: "",
        },
      };
      expect(await step.run(ctx, prior)).toBeNull();
      expect(dns._mocks.createRecord).not.toHaveBeenCalled();
    } finally {
      db.saveSetting("dns_zone_id", "");
      db.saveSetting("dns_zone_name", "");
    }
  });

  test("compensation deletes the previously created record", async () => {
    const out = {
      recordId: "rec-1",
      zoneId: "zone-x",
      name: "sub",
      type: "A",
      value: "1.2.3.4",
    };
    const { ctx } = makeCtx({});
    await step.compensate!(ctx, out, {});
    expect(dns._mocks.deleteRecord).toHaveBeenCalledTimes(1);
    expect(dns._mocks.deleteRecord.mock.calls[0][0]).toMatchObject({
      zoneId: "zone-x",
      name: "sub",
      type: "A",
    });
  });
});

describe("deploy step: create_volume", () => {
  const step = stepByName("create_volume");

  test("returns null when volume_size is missing or zero", async () => {
    const { ctx } = makeCtx(baseReq("x"));
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: false,
        providerServerId: "h-xyz",
        ingressIp: "1.1.1.1",
      },
    };
    expect(await step.run(ctx, prior)).toBeNull();

    const req2 = { ...baseReq("x"), volume_size: 0 };
    const { ctx: ctx2 } = makeCtx(req2);
    expect(await step.run(ctx2, prior)).toBeNull();

    expect(compute._mocks.volumeCreate).not.toHaveBeenCalled();
  });

  test("creates a volume and returns its providerId + mount path", async () => {
    db.saveSetting("default_location", "fsn1");
    const req = { ...baseReq(`vol-${randomSuffix()}`), volume_size: 25, volume_path: "/var/lib/data" };
    const { ctx } = makeCtx(req);
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: true,
        providerServerId: "h-new",
        ingressIp: "1.1.1.1",
      },
    };
    const out = (await step.run(ctx, prior)) as { volumeId: string; volumeMount: string; containerPath: string };
    expect(out.containerPath).toBe("/var/lib/data");
    expect(out.volumeMount.endsWith(":/var/lib/data")).toBe(true);
    expect(compute._mocks.volumeCreate).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeCreate.mock.calls[0][0]).toMatchObject({
      sizeGb: 25,
      serverId: "h-new",
      location: "fsn1",
    });
  });

  test("defaults containerPath to /data when volume_path not provided", async () => {
    const req = { ...baseReq(`vol-${randomSuffix()}`), volume_size: 10 };
    const { ctx } = makeCtx(req);
    const prior = {
      pick_or_provision_server: {
        serverId: 1,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: true,
        providerServerId: "h-new2",
        ingressIp: "1.1.1.1",
      },
    };
    const out = (await step.run(ctx, prior)) as { containerPath: string };
    expect(out.containerPath).toBe("/data");
  });

  test("compensation detaches (best-effort) then deletes the volume", async () => {
    const { ctx } = makeCtx({});
    await step.compensate!(ctx, { volumeId: "v-abc", volumeMount: "/mnt/x:/data", containerPath: "/data" }, {});
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete.mock.calls[0][0]).toBe("v-abc");
  });

  test("compensation swallows detach failure and still calls delete", async () => {
    compute._mocks.volumeDetach.mockImplementationOnce(async () => { throw new Error("already detached"); });
    const { ctx } = makeCtx({});
    await step.compensate!(ctx, { volumeId: "v-xyz", volumeMount: "", containerPath: "/d" }, {});
    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
  });
});

// --- health_check opt-out --------------------------------------------------

function setupDeployedApp(healthCheckFlag: boolean) {
  const server = db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "2.2.2.2",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    private_ipv4: "10.0.0.2",
  });
  const name = `hc-${randomSuffix()}`;
  const { app, replica } = db.insertAppWithFirstReplica(
    {
      name,
      domain: `${name}.example.com`,
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 5432,
      env_vars: "{}",
      health_check: healthCheckFlag,
    },
    server.id,
  );
  const prior = {
    pick_or_provision_server: {
      serverId: server.id,
      serverIp: server.ipv4,
      serverHostKey: "",
      provisioned: false,
      ingressIp: server.ipv4,
    },
    insert_app_row: {
      appId: app.id,
      replicaId: replica.id,
      containerName: name,
      hostPort: replica.host_port,
      domain: `${name}.example.com`,
      useInternalTls: false,
      environmentId: null,
      flatEnvVars: {},
      dockerfilePath: "Dockerfile",
    },
  };
  return { server, app, replica, prior, name };
}

describe("deploy step: health_check", () => {
  const step = stepByName("health_check");

  test("stores the health_check flag on the app row", () => {
    const { app } = setupDeployedApp(false);
    expect(db.getApp(app.id)!.health_check).toBe(0);
    const { app: app2 } = setupDeployedApp(true);
    expect(db.getApp(app2.id)!.health_check).toBe(1);
  });

  test("health_check:false skips the HTTP probe and marks the app running", async () => {
    const { app, replica, prior, name } = setupDeployedApp(false);
    const { ctx } = makeCtx({ ...baseReq(name), container_port: 5432, health_check: false });
    const out = (await step.run(ctx, prior)) as { healthy: boolean };
    expect(out.healthy).toBe(true);
    expect(containerRunningCheckMock).toHaveBeenCalledTimes(1);
    expect(healthCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("running");
    expect(db.getReplica(replica.id)!.status).toBe("running");
    expect(db.getDeployLog(app.id)).toContain("HTTP probe disabled; container is running");
  });

  test("health_check:false still fails the op when the container is not running", async () => {
    const { app, replica, prior, name } = setupDeployedApp(false);
    containerRunningCheckMock.mockImplementationOnce(async () => ({
      healthy: false,
      error: "Container is not running",
    }));
    const { ctx } = makeCtx({ ...baseReq(name), health_check: false });
    expect(step.run(ctx, prior)).rejects.toThrow(/did not become healthy/i);
    expect(healthCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("unhealthy");
    expect(db.getReplica(replica.id)!.status).toBe("unhealthy");
  });

  test("default (health_check omitted) still runs the HTTP probe", async () => {
    const { prior, name } = setupDeployedApp(true);
    const { ctx } = makeCtx(baseReq(name));
    await step.run(ctx, prior);
    expect(healthCheckMock).toHaveBeenCalledTimes(1);
    expect(containerRunningCheckMock).not.toHaveBeenCalled();
  });
});

describe("redeploy step: health_check", () => {
  const step = redeployOp.steps.find((s) => s.name === "health_check")!;

  test("honors the stored health_check=0 flag (skips HTTP probe)", async () => {
    const { app } = setupDeployedApp(false);
    const { ctx } = makeCtx({ appId: app.id });
    const out = (await step.run(ctx, {})) as { healthy: boolean };
    expect(out.healthy).toBe(true);
    expect(containerRunningCheckMock).toHaveBeenCalledTimes(1);
    expect(healthCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("running");
    expect(db.getDeployLog(app.id)).toContain("HTTP probe disabled; container is running");
  });

  test("keeps the HTTP probe for apps with health_check=1", async () => {
    const { app } = setupDeployedApp(true);
    const { ctx } = makeCtx({ appId: app.id });
    await step.run(ctx, {});
    expect(healthCheckMock).toHaveBeenCalledTimes(1);
    expect(containerRunningCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("running");
  });
});

// --- Feature A: private apps ------------------------------------------------

describe("resolveAppDomain", () => {
  test("private apps get no domain regardless of settings", () => {
    expect(resolveAppDomain({ app_name: "a", public: false }, { dns_zone_id: "z1" }, "1.2.3.4"))
      .toEqual({ domain: "", managedDns: false });
    expect(resolveAppDomain(
      { app_name: "a", public: false },
      { dns_zone_id: "z1", dns_zone_name: "example.com" },
      "1.2.3.4",
    )).toEqual({ domain: "", managedDns: false });
  });

  test("explicit domain is kept; managedDns follows dns_zone_id", () => {
    expect(resolveAppDomain({ app_name: "a", domain: "a.example.com" }, { dns_zone_id: "z1" }, "1.2.3.4"))
      .toEqual({ domain: "a.example.com", managedDns: true });
    expect(resolveAppDomain({ app_name: "a", domain: "a.example.com" }, {}, "1.2.3.4"))
      .toEqual({ domain: "a.example.com", managedDns: false });
  });

  test("explicit domain beats the auto-domain", () => {
    expect(resolveAppDomain(
      { app_name: "a", domain: "custom.other.org" },
      { dns_zone_id: "z1", dns_zone_name: "example.com" },
      "1.2.3.4",
    )).toEqual({ domain: "custom.other.org", managedDns: true });
  });

  test("auto-domain <app>.<zone> when a zone is configured and no domain given", () => {
    expect(resolveAppDomain(
      { app_name: "a" },
      { dns_zone_id: "z1", dns_zone_name: "example.com" },
      "1.2.3.4",
    )).toEqual({ domain: "a.example.com", managedDns: true });
  });

  test("falls back to nip.io only when no zone is configured or resolvable", () => {
    expect(resolveAppDomain({ app_name: "a" }, {}, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io", managedDns: false });
    // Zone id without a resolvable name -> nip.io, unmanaged.
    expect(resolveAppDomain({ app_name: "a" }, { dns_zone_id: "z1" }, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io", managedDns: false });
    expect(resolveAppDomain({ app_name: "a" }, { dns_zone_id: "z1", dns_zone_name: "" }, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io", managedDns: false });
    // Zone name without a zone id (stale cache) -> nip.io.
    expect(resolveAppDomain({ app_name: "a" }, { dns_zone_name: "example.com" }, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io", managedDns: false });
  });
});

describe("deploy: private apps", () => {
  const serverPrior = (server: { id: number; ipv4: string }) => ({
    pick_or_provision_server: {
      serverId: server.id,
      serverIp: server.ipv4,
      serverHostKey: "",
      provisioned: false,
      ingressIp: server.ipv4,
    },
    create_dns_record: null,
    create_volume: null,
  });

  function makeReadyServer() {
    return db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "3.3.3.3",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
      private_ipv4: "10.0.0.3",
    });
  }

  test("create_dns_record returns null for private apps even with a zone configured", async () => {
    db.saveSetting("dns_zone_id", "zone-123");
    const step = stepByName("create_dns_record");
    const { ctx } = makeCtx({ ...baseReq("x"), domain: "", public: false });
    const out = await step.run(ctx, serverPrior({ id: 1, ipv4: "1.1.1.1" }));
    expect(out).toBeNull();
    expect(dns._mocks.createRecord).not.toHaveBeenCalled();
  });

  test("insert_app_row stores an empty domain and allocates an internal port", async () => {
    const server = makeReadyServer();
    const name = `priv-${randomSuffix()}`;
    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: name,
      git_repo: "https://github.com/x/y",
      container_port: 3000,
      public: false,
    });
    const out = (await step.run(ctx, serverPrior(server))) as { appId: number; domain: string; useInternalTls: boolean };
    expect(out.domain).toBe("");
    expect(out.useInternalTls).toBe(false);
    const app = db.getApp(out.appId)!;
    expect(app.domain).toBe("");
    expect(app.public).toBe(0);
    expect(app.internal_port).toBeGreaterThanOrEqual(db.INTERNAL_PORT_BASE);
  });

  test("finalize_deploy sets desired_replicas for private apps with replicas > 1", async () => {
    const name = `priv-${randomSuffix()}`;
    const app = db.insertApp({
      name,
      domain: "",
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
      public: false,
    });
    const step = stepByName("finalize_deploy");
    const { ctx } = makeCtx({ app_name: name, git_repo: "https://github.com/x/y", container_port: 3000, public: false, replicas: 2 });
    await step.run(ctx, { insert_app_row: { appId: app.id } });
    // No child op is enqueued — the reconciler converges to desired_replicas.
    expect(db.getApp(app.id)!.desired_replicas).toBe(2);
  });

  test("finalize_deploy leaves desired_replicas at 1 for public apps without a domain", async () => {
    const name = `pub-${randomSuffix()}`;
    const app = db.insertApp({
      name,
      domain: "",
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
      public: true,
    });
    const step = stepByName("finalize_deploy");
    const { ctx } = makeCtx({ app_name: name, git_repo: "https://github.com/x/y", container_port: 3000, replicas: 2 });
    await step.run(ctx, { insert_app_row: { appId: app.id, domain: "" } });
    expect(db.getApp(app.id)!.desired_replicas).toBe(1);
  });
});

// --- Feature B: auto-domains --------------------------------------------------

describe("deploy: auto-domains", () => {
  function makeReadyServer() {
    return db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "3.3.3.4",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
      private_ipv4: "10.0.0.4",
    });
  }

  const serverPrior = (server: { id: number; ipv4: string }, zoneName: string) => ({
    pick_or_provision_server: {
      serverId: server.id,
      serverIp: server.ipv4,
      serverHostKey: "",
      provisioned: false,
      ingressIp: server.ipv4,
      zoneName,
    },
    create_dns_record: null,
    create_volume: null,
  });

  test("insert_app_row stores <app>.<zone> using the prior step's zone name (replay-deterministic)", async () => {
    const server = makeReadyServer();
    const name = `auto-${randomSuffix()}`;
    // The live setting deliberately differs from the prior-step output: the
    // saga must keep using the value captured at pick_or_provision_server.
    db.saveSetting("dns_zone_id", "zone-auto");
    db.saveSetting("dns_zone_name", "changed-since.example.org");
    try {
      const step = stepByName("insert_app_row");
      const { ctx } = makeCtx({ app_name: name, git_repo: "https://github.com/x/y", container_port: 3000 });
      const out = (await step.run(ctx, serverPrior(server, "example.com"))) as {
        appId: number; domain: string; useInternalTls: boolean;
      };
      expect(out.domain).toBe(`${name}.example.com`);
      expect(out.useInternalTls).toBe(false);
      expect(db.getApp(out.appId)!.domain).toBe(`${name}.example.com`);
    } finally {
      db.saveSetting("dns_zone_id", "");
      db.saveSetting("dns_zone_name", "");
    }
  });

  test("insert_app_row keeps the nip.io fallback when the zone name is unresolved", async () => {
    const server = makeReadyServer();
    const name = `auto-${randomSuffix()}`;
    db.saveSetting("dns_zone_id", "zone-auto");
    db.saveSetting("dns_zone_name", "");
    try {
      const step = stepByName("insert_app_row");
      const { ctx } = makeCtx({ app_name: name, git_repo: "https://github.com/x/y", container_port: 3000 });
      const out = (await step.run(ctx, serverPrior(server, ""))) as { domain: string; useInternalTls: boolean };
      expect(out.domain).toBe(`${name}.${server.ipv4}.nip.io`);
      expect(out.useInternalTls).toBe(true);
    } finally {
      db.saveSetting("dns_zone_id", "");
      db.saveSetting("dns_zone_name", "");
    }
  });
});

describe("deploy op: structure", () => {
  test("has the expected step sequence", () => {
    const names = deployOp.steps.map((s) => s.name);
    expect(names).toEqual([
      "pick_or_provision_server",
      "create_dns_record",
      "create_volume",
      "insert_app_row",
      "setup_volume_bind_mount",
      "clone_repo",
      "build_and_run_container",
      "sync_ingress",
      "health_check",
      "record_deployment_history",
      "setup_github_webhook",
      "finalize_deploy",
    ]);
  });

  test("kind + resource key format", () => {
    expect(deployOp.kind).toBe("deploy");
    expect(deployOp.resourceKeys({ app_name: "foo" } as any)).toEqual(["app:create:foo"]);
  });
});

// Keep last: fills the whole internal port block (fleet app cap).
describe("deploy step: pick_or_provision_server fleet cap", () => {
  test("rejects a deploy once 200 apps exist", async () => {
    const fillers: number[] = [];
    try {
      while (db.countApps() < db.INTERNAL_PORT_COUNT) {
        const name = `cap-${randomSuffix()}`;
        fillers.push(db.insertApp({
          name,
          domain: `${name}.example.com`,
          git_repo: "https://github.com/x/y",
          dockerfile_path: "Dockerfile",
          container_port: 3000,
          env_vars: "{}",
        }).id);
      }
      const step = stepByName("pick_or_provision_server");
      const { ctx } = makeCtx(baseReq(`cap-final-${randomSuffix()}`));
      expect(step.run(ctx, {})).rejects.toThrow(/fleet limit of 200 apps/i);
    } finally {
      // Free the block again — later test files share this db.
      for (const id of fillers) db.deleteApp(id);
    }
  });
});
