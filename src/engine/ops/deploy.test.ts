import { useTempDataDir, makeFakeComputeProvider, randomSuffix, configureTestInfrastructureProvider } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const compute = makeFakeComputeProvider();

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
const containerExistsMock = mock(async () => false);
const getContainerLogsMock = mock(async () => "");
const removeContainerMock = mock(async () => {});
let attestationAppName = "";
let attestationEnvHash = "";
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async (_ip: string, command: string) => ({
    exitCode: 0,
    stdout: command.includes("{{json .}}") ? JSON.stringify({
      Image: "sha256:test-image",
      State: { Running: true },
      Config: { Labels: {
        "ocd.app": attestationAppName,
        "ocd.config-revision": "1",
        "ocd.env-hash": attestationEnvHash,
        "ocd.image-ref": "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "ocd.image-id": "sha256:test-image",
      } },
    }) : "",
    stderr: "",
  })),
  removeContainer: removeContainerMock,
  healthCheck: healthCheckMock,
  containerRunningCheck: containerRunningCheckMock,
  // probeAppHealth dispatches to healthCheck/containerRunningCheck by app.health_check.
  // Provide it explicitly so these mocks are observed even if another test file
  // (run earlier in the same process) already evaluated health.ts under its own
  // remote mock — a cross-file mock.module binding that our re-mock can't re-propagate.
  probeAppHealth: mock(async (app: { health_check: number }) =>
    app.health_check ? healthCheckMock() : containerRunningCheckMock(),
  ),
  containerExists: containerExistsMock,
  getContainerLogs: getContainerLogsMock,
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
import { __replaceInfrastructureProvidersForTest } from "../../shared/providers/index.ts";
import deployOp, { appVolumeName, resolveAppDomain } from "./deploy.ts";
import redeployOp from "./redeploy.ts";
import rollbackOp from "./rollback.ts";
import promoteOp from "./promote.ts";

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

async function primeAttestation(app: db.AppRow): Promise<void> {
  const { resolveAppEnvVars } = await import("../../shared/env-crypto.ts");
  const { hashEnvironment } = await import("../revision.ts");
  attestationAppName = app.name;
  attestationEnvHash = hashEnvironment(await resolveAppEnvVars(app));
}

beforeEach(() => {
  __replaceInfrastructureProvidersForTest([compute]);
  configureTestInfrastructureProvider(compute.id);
  provisionServer.mockClear();
  compute._mocks.volumeCreate.mockClear();
  compute._mocks.volumeDelete.mockClear();
  compute.volumes.list = async () => [];
  healthCheckMock.mockClear();
  containerRunningCheckMock.mockClear();
  containerExistsMock.mockClear();
  containerExistsMock.mockImplementation(async () => false);
  getContainerLogsMock.mockClear();
  getContainerLogsMock.mockImplementation(async () => "");
  removeContainerMock.mockClear();
});

const baseReq = (name: string) => ({
  app_name: name,
  image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

});

describe("deploy step: create_volume", () => {
  const step = stepByName("create_volume");
  const managedServer = (providerId: string) => db.insertServer({
    name: `volume-server-${randomSuffix()}`,
    provider_id: providerId,
    provider: "hetzner",
    ownership: "managed",
    ipv4: "1.1.1.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });

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
    const server = managedServer("h-new");
    const req = { ...baseReq(`vol-${randomSuffix()}`), volume_size: 25, volume_path: "/var/lib/data" };
    const { ctx } = makeCtx(req);
    const prior = {
      pick_or_provision_server: {
        serverId: server.id,
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
      name: appVolumeName(req.app_name, ctx.opId),
      sizeGb: 25,
      serverId: "h-new",
      location: "fsn1",
    });
  });

  test("probe refuses a retained same-name volume instead of blind adoption", async () => {
    db.saveSetting("default_location", "fsn1");
    const server = managedServer("h-new");
    const req = { ...baseReq(`collision-${randomSuffix()}`), volume_size: 10 };
    const { ctx } = makeCtx(req);
    const name = appVolumeName(req.app_name, ctx.opId);
    db.retireVolume({
      providerVolumeId: "vol-retained-app",
      driverId: "hetzner-block",
      formerResourceType: "app",
      formerResourceId: 0,
      formerResourceName: req.app_name,
      reason: "prior deployment compensated",
    });
    compute.volumes.list = async () => [{
      providerId: "vol-retained-app",
      name,
      sizeGb: 10,
      location: "fsn1",
      serverId: null,
    }];
    const prior = {
      pick_or_provision_server: {
        serverId: server.id,
        serverIp: "1.1.1.1",
        serverHostKey: "",
        provisioned: true,
        providerServerId: "h-new",
        ingressIp: "1.1.1.1",
      },
    };
    await expect(step.probe!(ctx, prior)).rejects.toThrow(/Refusing to adopt retained volume/);
  });

  test("defaults containerPath to /data when volume_path not provided", async () => {
    const server = managedServer("h-new2");
    const req = { ...baseReq(`vol-${randomSuffix()}`), volume_size: 10 };
    const { ctx } = makeCtx(req);
    const prior = {
      pick_or_provision_server: {
        serverId: server.id,
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

  test("compensation detaches and retains the volume", async () => {
    const { ctx } = makeCtx({});
    await step.compensate!(ctx, {
      volumeId: "v-abc",
      driverId: "hetzner-block",
      volumeMount: "/mnt/x:/data",
      containerPath: "/data",
      attached: false,
      detachOnCompensate: true,
    }, {});
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
    expect(db.getRetiredVolumes().find((v) => v.provider_volume_id === "v-abc")?.retention_class).toBe("provisional");
  });

  test("compensation preserves a volume that was already attached before deployment", async () => {
    const { ctx } = makeCtx({});
    const detachCallsBefore = compute._mocks.volumeDetach.mock.calls.length;
    await step.compensate!(ctx, {
      volumeId: "v-existing",
      driverId: "hetzner-block",
      volumeMount: "/mnt/vol-v-existing:/data",
      containerPath: "/data",
      attached: true,
      detachOnCompensate: false,
    }, {});
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(detachCallsBefore);
    expect(db.getRetiredVolumes().some((v) => v.provider_volume_id === "v-existing")).toBe(false);
  });

  test("compensation surfaces detach failure and does not claim retirement", async () => {
    compute._mocks.volumeDetach.mockImplementationOnce(async () => { throw new Error("ssh/provider unavailable"); });
    const { ctx } = makeCtx({});
    await expect(
      step.compensate!(ctx, {
        volumeId: "v-xyz",
        driverId: "hetzner-block",
        volumeMount: "",
        containerPath: "/d",
        attached: false,
        detachOnCompensate: true,
      }, {}),
    ).rejects.toThrow(/unavailable/);
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
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
    routing_address: "10.0.0.2",
  });
  const name = `hc-${randomSuffix()}`;
  const { app, replica } = db.insertAppWithFirstReplica(
    {
      name,
      domain: `${name}.example.com`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
    },
    pull_and_run_container: {
      imageTag: app.image_ref,
      imageDigest: app.image_ref,
    },
  };
  attestationAppName = name;
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
    await primeAttestation(app);
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
    const { app, prior, name } = setupDeployedApp(true);
    await primeAttestation(app);
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
    await primeAttestation(app);
    const { ctx } = makeCtx({ appId: app.id });
    const out = (await step.run(ctx, { pull_and_run_candidate: { imageTag: app.image_ref, imageDigest: app.image_ref } })) as { healthy: boolean };
    expect(out.healthy).toBe(true);
    expect(containerRunningCheckMock).toHaveBeenCalledTimes(1);
    expect(healthCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("running");
    expect(db.getDeployLog(app.id)).toContain("HTTP probe disabled; container is running");
  });

  test("keeps the HTTP probe for apps with health_check=1", async () => {
    const { app } = setupDeployedApp(true);
    await primeAttestation(app);
    const { ctx } = makeCtx({ appId: app.id });
    await step.run(ctx, { pull_and_run_candidate: { imageTag: app.image_ref, imageDigest: app.image_ref } });
    expect(healthCheckMock).toHaveBeenCalledTimes(1);
    expect(containerRunningCheckMock).not.toHaveBeenCalled();
    expect(db.getApp(app.id)!.status).toBe("running");
  });
});

// --- Feature A: private apps ------------------------------------------------

describe("resolveAppDomain", () => {
  test("private apps get no domain regardless of settings", () => {
    expect(resolveAppDomain({ app_name: "a", public: false }, { default_domain_suffix: "example.com" }, "1.2.3.4"))
      .toEqual({ domain: "" });
    expect(resolveAppDomain(
      { app_name: "a", public: false },
      {},
      "1.2.3.4",
    )).toEqual({ domain: "" });
  });

  test("explicit domain is returned unchanged and remains operator-owned", () => {
    expect(resolveAppDomain({ app_name: "a", domain: "a.example.com" }, { default_domain_suffix: "example.com" }, "1.2.3.4"))
      .toEqual({ domain: "a.example.com" });
    expect(resolveAppDomain({ app_name: "a", domain: "a.example.com" }, {}, "1.2.3.4"))
      .toEqual({ domain: "a.example.com" });
  });

  test("explicit domain beats the auto-domain", () => {
    expect(resolveAppDomain(
      { app_name: "a", domain: "custom.other.org" },
      { default_domain_suffix: "example.com" },
      "1.2.3.4",
    )).toEqual({ domain: "custom.other.org" });
  });

  test("auto-domain uses the provider-neutral default suffix", () => {
    expect(resolveAppDomain(
      { app_name: "a" },
      { default_domain_suffix: "example.com" },
      "1.2.3.4",
    )).toEqual({ domain: "a.example.com" });
  });

  test("falls back to nip.io when no default suffix is configured", () => {
    expect(resolveAppDomain({ app_name: "a" }, {}, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io" });
    expect(resolveAppDomain({ app_name: "a" }, { default_domain_suffix: "" }, "1.2.3.4"))
      .toEqual({ domain: "a.1.2.3.4.nip.io" });
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
      routing_address: "10.0.0.3",
    });
  }

  test("insert_app_row stores an empty domain and allocates an internal port", async () => {
    const server = makeReadyServer();
    const name = `priv-${randomSuffix()}`;
    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: name,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

  test("insert_app_row layers env_vars on top of a linked environment (existing wins, new keys added)", async () => {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const server = makeReadyServer();
    const linked = db.insertEnvironment(
      `linked-${randomSuffix()}`,
      serializeEnvVars([{ key: "KEEP", value: "orig", secret: false, updated_at: "t" }]),
    );
    const step = stepByName("insert_app_row");
    // KEEP already lives in the env (should persist); ADDED is new (should land).
    const { ctx } = makeCtx({
      app_name: `link-${randomSuffix()}`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      public: false,
      environment_id: linked.id,
      env_vars: [{ key: "ADDED", value: "new", secret: false }],
    });
    const out = (await step.run(ctx, serverPrior(server))) as { environmentId: number };
    expect(out.environmentId).toBe(linked.id);
    const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
    const flat = await resolveEnvVarsForDeploy(db.getEnvironment(linked.id)!.env_vars);
    expect(flat).toEqual({ KEEP: "orig", ADDED: "new" });
  });

  test("finalize_deploy succeeds only after every desired replica is attested", async () => {
    const name = `priv-${randomSuffix()}`;
    const server = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "10.0.0.10",
      routing_address: "10.0.0.10",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const app = db.insertApp({
      name,
      domain: "",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
      public: false,
    });
    db.updateAppScaling(app.id, { desired_replicas: 2, min_replicas: 2, max_replicas: 2 });
    for (let i = 1; i <= 2; i++) {
      const replica = db.insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 10_000 + i,
        container_name: `${name}-r${i}`,
        status: "running",
      });
      db.recordReplicaAttestation(replica.id, {
        imageDigest: "sha256:test-image",
        envHash: "test-env",
        configRevision: app.config_revision,
      });
    }
    const step = stepByName("finalize_deploy");
    const { ctx } = makeCtx({ app_name: name, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000, public: false, replicas: 2 });
    await step.run(ctx, { insert_app_row: { appId: app.id } });
    expect(db.getApp(app.id)!.desired_replicas).toBe(2);
  });

  test("finalize_deploy rejects an unattested desired replica instead of reporting success", async () => {
    const name = `pub-${randomSuffix()}`;
    const server = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "10.0.0.11",
      routing_address: "10.0.0.11",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const app = db.insertApp({
      name,
      domain: "",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
      public: true,
    });
    db.updateAppScaling(app.id, { desired_replicas: 2, min_replicas: 2, max_replicas: 2 });
    for (let i = 1; i <= 2; i++) {
      const replica = db.insertReplica({
        app_id: app.id,
        server_id: server.id,
        host_port: 11_000 + i,
        container_name: `${name}-r${i}`,
        status: "running",
      });
      if (i === 1) {
        db.recordReplicaAttestation(replica.id, {
          imageDigest: "sha256:test-image",
          envHash: "test-env",
          configRevision: app.config_revision,
        });
      }
    }
    const step = stepByName("finalize_deploy");
    const { ctx } = makeCtx({ app_name: name, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000, replicas: 2 });
    await expect(step.run(ctx, { insert_app_row: { appId: app.id, domain: "" } }))
      .rejects.toThrow(/replica convergence incomplete/i);
    expect(db.getApp(app.id)!.desired_replicas).toBe(2);
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
      routing_address: "10.0.0.4",
    });
  }

  const serverPrior = (server: { id: number; ipv4: string }) => ({
    pick_or_provision_server: {
      serverId: server.id,
      serverIp: server.ipv4,
      serverHostKey: "",
      provisioned: false,
      ingressIp: server.ipv4,
    },
    create_volume: null,
  });

  test("insert_app_row stores <app>.<default suffix>", async () => {
    const server = makeReadyServer();
    const name = `auto-${randomSuffix()}`;
    db.saveSetting("default_domain_suffix", "example.com");
    try {
      const step = stepByName("insert_app_row");
      const { ctx } = makeCtx({ app_name: name, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000 });
      const out = (await step.run(ctx, serverPrior(server))) as {
        appId: number; domain: string; useInternalTls: boolean;
      };
      expect(out.domain).toBe(`${name}.example.com`);
      expect(out.useInternalTls).toBe(false);
      expect(db.getApp(out.appId)!.domain).toBe(`${name}.example.com`);
    } finally {
      db.saveSetting("default_domain_suffix", "");
    }
  });

  test("insert_app_row keeps the nip.io fallback when the default suffix is unset", async () => {
    const server = makeReadyServer();
    const name = `auto-${randomSuffix()}`;
    db.saveSetting("default_domain_suffix", "");
    try {
      const step = stepByName("insert_app_row");
      const { ctx } = makeCtx({ app_name: name, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000 });
      const out = (await step.run(ctx, serverPrior(server))) as { domain: string; useInternalTls: boolean };
      expect(out.domain).toBe(`${name}.${server.ipv4}.nip.io`);
      expect(out.useInternalTls).toBe(true);
    } finally {
      db.saveSetting("default_domain_suffix", "");
    }
  });
});

describe("deploy op: structure", () => {
  test("existing-app candidates pass readiness before configuration commit", () => {
    const names = redeployOp.steps.map((step) => step.name);
    expect(names.indexOf("validate_candidate")).toBeLessThan(names.indexOf("commit_candidate_config"));
    expect(names.indexOf("roll_extra_replicas")).toBeLessThan(names.indexOf("commit_candidate_config"));
    expect(names.indexOf("commit_candidate_config")).toBeLessThan(names.indexOf("health_check"));
  });

  test("revision-changing operations complete a reversible snapshot before mutation", () => {
    for (const op of [redeployOp, rollbackOp, promoteOp]) {
      const names = op.steps.map((step) => step.name);
      const snapshotIndex = names.indexOf("snapshot_current_revision");
      expect(snapshotIndex).toBeGreaterThan(0);
      expect(op.steps[snapshotIndex].compensate).toBeFunction();

      const firstMutation = op.kind === "redeploy"
        ? names.indexOf("pull_and_run_candidate")
        : names.indexOf("prepare_environment");
      expect(snapshotIndex).toBeLessThan(firstMutation);
      expect(names.at(-1)).toBe("discard_revision_snapshot");
    }
  });

  test("a failing artifact rollout or swap is restored by the prior completed snapshot step", () => {
    const redeployArtifact = redeployOp.steps.find((step) => step.name === "pull_and_run_candidate");
    const rollbackSwap = rollbackOp.steps.find((step) => step.name === "swap_container");
    const promoteSwap = promoteOp.steps.find((step) => step.name === "swap_container");
    expect(redeployArtifact?.compensate).toBeUndefined();
    expect(rollbackSwap?.compensate).toBeUndefined();
    expect(promoteSwap?.compensate).toBeUndefined();
  });

  test("has the expected step sequence", () => {
    const names = deployOp.steps.map((s) => s.name);
    expect(names).toEqual([
      "pick_or_provision_server",
      "create_volume",
      "insert_app_row",
      "setup_volume_bind_mount",
      "pull_and_run_container",
      "sync_ingress",
      "health_check",
      "record_deployment_history",
      "finalize_deploy",
    ]);
  });

  test("kind + resource key format", () => {
    expect(deployOp.kind).toBe("deploy");
    expect(deployOp.resourceKeys({ app_name: "foo" } as any)).toEqual(["app:create:foo"]);
  });
});

// --- Deploy targets: isolated environments -----------------------------------

describe("deploy step: insert_app_row deploy targets", () => {
  function makeReadyServer() {
    return db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "3.3.3.5",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
      routing_address: "10.0.0.5",
    });
  }

  const serverPrior = (server: { id: number; ipv4: string }) => ({
    pick_or_provision_server: {
      serverId: server.id,
      serverIp: server.ipv4,
      serverHostKey: "",
      provisioned: false,
      ingressIp: server.ipv4,
    },
    create_volume: null,
  });

  /** Parent production app with a linked environment. */
  async function makeParentWithEnvironment() {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const parentName = `prod-${randomSuffix()}`;
    const parentEnv = db.insertEnvironment(
      parentName,
      serializeEnvVars([{ key: "DATABASE_URL", value: "postgres://prod-db", secret: false, updated_at: "t" }]),
    );
    const parent = db.insertApp({
      name: parentName,
      domain: `${parentName}.example.com`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
      environment_id: parentEnv.id,
      target: "production",
    });
    return { parent, parentEnv, parentName };
  }

  test("non-production target deploys with its explicitly selected environment; no live inheritance", async () => {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const server = makeReadyServer();
    const { parent, parentName } = await makeParentWithEnvironment();
    const stagingName = `${parentName}-staging`;
    // The user duplicated production's environment and tweaked it — staging is
    // deployed with THIS explicit env, nothing inherited from the parent.
    const stagingEnv = db.insertEnvironment(
      stagingName,
      serializeEnvVars([{ key: "DATABASE_URL", value: "postgres://staging-db", secret: false, updated_at: "t" }]),
    );

    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: stagingName,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      target: "staging",
      target_of: parent.id,
      environment_id: stagingEnv.id,
      placement_pool: "staging",
    });
    const out = (await step.run(ctx, serverPrior(server))) as {
      appId: number;
      environmentId: number | null;
      flatEnvVars: Record<string, string>;
    };

    // App row carries the target tag, parent link, and pool.
    const app = db.getApp(out.appId)!;
    expect(app.target).toBe("staging");
    expect(app.target_of).toBe(parent.id);
    expect(app.placement_pool).toBe("staging");

    // Links to the selected env and resolves ONLY its vars — the parent's
    // DATABASE_URL does not leak in (no inheritance).
    expect(out.environmentId).toBe(stagingEnv.id);
    expect(out.flatEnvVars).toEqual({ DATABASE_URL: "postgres://staging-db" });

  });

  test("an explicit environment_id is used as-is (no isolated-environment creation)", async () => {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const server = makeReadyServer();
    const { parent, parentName } = await makeParentWithEnvironment();
    const linked = db.insertEnvironment(`explicit-${randomSuffix()}`, serializeEnvVars([]));
    const devName = `${parentName}-dev`;

    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: devName,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      target: "dev",
      target_of: parent.id,
      environment_id: linked.id,
    });
    const out = (await step.run(ctx, serverPrior(server))) as { environmentId: number | null };
    expect(out.environmentId).toBe(linked.id);
    // No "<app_name>" environment was created.
    expect(db.getEnvironments().some((e) => e.name === devName)).toBe(false);
  });

  test("production target creates no isolated environment", async () => {
    const server = makeReadyServer();
    const name = `prod-only-${randomSuffix()}`;
    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: name,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      target: "production",
      placement_pool: "general",
    });
    const out = (await step.run(ctx, serverPrior(server))) as { appId: number; environmentId: number | null };
    const app = db.getApp(out.appId)!;
    expect(app.target).toBe("production");
    expect(app.target_of).toBeNull();
    expect(out.environmentId).toBeNull();
    expect(db.getEnvironments().some((e) => e.name === name)).toBe(false);
  });

  test("non-production target with no selected environment creates none and resolves an empty env", async () => {
    const server = makeReadyServer();
    const parentName = `bare-${randomSuffix()}`;
    const parent = db.insertApp({
      name: parentName,
      domain: `${parentName}.example.com`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
    });
    const stagingName = `${parentName}-staging`;
    const step = stepByName("insert_app_row");
    const { ctx } = makeCtx({
      app_name: stagingName,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      target: "staging",
      target_of: parent.id,
    });
    const out = (await step.run(ctx, serverPrior(server))) as { environmentId: number | null; flatEnvVars: Record<string, string> };
    // No env is auto-created and none is linked; the container just gets no
    // user env vars (staging without a selected environment).
    expect(db.getEnvironments().some((e) => e.name === stagingName)).toBe(false);
    expect(out.environmentId).toBeNull();
    expect(out.flatEnvVars).toEqual({});
  });
});

describe("contract: engine deploy back-compat shim for legacy env_label/sibling_of (T3a)", () => {
  // REGRESSION: currently failing by design — pinned desired behavior
  test("a DeployRequest carrying env_label/sibling_of behaves exactly like target/target_of", async () => {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const server = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "3.3.3.6",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
      routing_address: "10.0.0.6",
    });
    const parentName = `legacy-${randomSuffix()}`;
    const parentEnv = db.insertEnvironment(
      parentName,
      serializeEnvVars([{ key: "SEED", value: "from-prod", secret: false, updated_at: "t" }]),
    );
    const parent = db.insertApp({
      name: parentName,
      domain: `${parentName}.example.com`,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
      environment_id: parentEnv.id,
    });
    const stagingName = `${parentName}-staging`;

    const step = deployOp.steps.find((s) => s.name === "insert_app_row")!;
    // Legacy wire field names only — NOT target/target_of.
    const { ctx } = makeCtx({
      app_name: stagingName,
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_label: "staging",
      sibling_of: parent.id,
    });
    const out = (await step.run(ctx, {
      pick_or_provision_server: {
        serverId: server.id,
        serverIp: server.ipv4,
        serverHostKey: "",
        provisioned: false,
        ingressIp: server.ipv4,
      },
      create_volume: null,
    })) as { appId: number; environmentId: number | null; flatEnvVars: Record<string, string> };

    // Target tag stored + target_of link set from the legacy names — that's all
    // the shim does. There is no isolated-env creation or inheritance anymore.
    const app = db.getApp(out.appId)!;
    expect(app.target).toBe("staging");
    expect(app.target_of).toBe(parent.id);
    expect(out.environmentId).toBeNull();
    expect(out.flatEnvVars).toEqual({});
    expect(db.getEnvironments().some((e) => e.name === stagingName)).toBe(false);
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
          image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
