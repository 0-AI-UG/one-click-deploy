import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock the provider, container-recreate and host-mount deps before importing the
// op (static imports). The fake provider id is left as "hetzner" but the bind
// step is exercised only via its (sleep-free) compensate path in these tests.
const compute = makeFakeComputeProvider();
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

const ensureVolumeBindMount = mock(async () => {});
const removeVolumeBindMount = mock(async () => {});

mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

import * as db from "../../shared/db.ts";
import attachVolumeOp from "./attach-volume.ts";
import { __setBindImplForTest, __resetBindImplForTest } from "./_volumes.ts";

function makeCtx(input: any, opId = 42) {
  const logLines: string[] = [];
  return {
    ctx: {
      opId,
      kind: "attach_volume",
      input,
      trigger: "ui" as const,
      triggeredBy: "",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: (l: string) => logLines.push(l),
      park: () => {},
      unpark: () => {},
    } as any,
    logLines,
  };
}

function stepByName(name: string) {
  const step = attachVolumeOp.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
}

function makeApp(opts: { minReplicas?: number; maxReplicas?: number; withVolume?: boolean; replicas?: number } = {}) {
  const server = db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "2.2.2.2",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
  const name = `av-${randomSuffix()}`;
  const { app, replica } = db.insertAppWithFirstReplica(
    { name, domain: `${name}.example.com`, git_repo: "https://github.com/x/y", dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}" },
    server.id,
  );
  if (opts.minReplicas !== undefined || opts.maxReplicas !== undefined) {
    db.updateAppScaling(app.id, { min_replicas: opts.minReplicas ?? 1, max_replicas: opts.maxReplicas ?? 1 });
  }
  if (opts.withVolume) db.updateAppVolume(app.id, "v-existing", "/mnt/x:/data");
  return { server, app: db.getApp(app.id)!, replica };
}

beforeEach(() => {
  compute._mocks.volumeCreate.mockClear();
  compute._mocks.volumeDelete.mockClear();
  compute._mocks.volumeAttach.mockClear();
  compute._mocks.volumeDetach.mockClear();
  recreateAppContainer.mockClear();
  recreateAppContainer.mockImplementation(async () => ({ ok: true }));
  __setBindImplForTest({ ensureVolumeBindMount, removeVolumeBindMount });
});

afterEach(() => __resetBindImplForTest());

describe("attach_volume: validate", () => {
  const step = stepByName("validate");

  test("returns the single-replica target", async () => {
    const { app, server } = makeApp();
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 });
    const out = (await step.run(ctx, {})) as any;
    expect(out.providerServerId).toBe(server.provider_id);
    expect(out.serverLocation).toBe("fsn1");
    expect(out.appName).toBe(app.name);
  });

  test("throws when the app already has a volume", async () => {
    const { app } = makeApp({ withVolume: true });
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 });
    expect(step.run(ctx, {})).rejects.toThrow(/already has a volume/i);
  });

  test("throws when the app has more than 1 replica", async () => {
    const { app, server } = makeApp();
    db.insertReplica({ app_id: app.id, server_id: server.id, container_name: `${app.name}-2`, host_port: 40001, status: "running" });
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 });
    expect(step.run(ctx, {})).rejects.toThrow(/more than 1 replica/i);
  });
});

describe("attach_volume: create_volume", () => {
  const step = stepByName("create_volume");

  test("creates a deterministically-named volume from the op id", async () => {
    const { app, server } = makeApp();
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 25 }, 77);
    const target = { providerServerId: server.provider_id, serverLocation: "fsn1", appName: app.name } as any;
    const out = (await step.run(ctx, { validate: target })) as any;
    expect(compute._mocks.volumeCreate).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeCreate.mock.calls[0][0]).toMatchObject({
      name: `ocd-${app.name}-op77`,
      sizeGb: 25,
      serverId: server.provider_id,
      location: "fsn1",
    });
    expect(out.hostMountPath).toBe(`/mnt/ocd-${app.name}-op77`);
  });

  test("compensate detaches (best-effort) then deletes the volume", async () => {
    const { ctx } = makeCtx({ appId: 1, sizeGb: 10 });
    await step.compensate!(ctx, { volumeId: "v-abc", hostMountPath: "/mnt/x", volName: "x" }, {});
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete.mock.calls[0][0]).toBe("v-abc");
  });
});

describe("attach_volume: attach_to_app", () => {
  const step = stepByName("attach_to_app");

  test("records the volume and forces min/max replicas to 1, storing the prior values", async () => {
    const { app } = makeApp({ minReplicas: 2, maxReplicas: 5 });
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10, mountPath: "/var/data" });
    const vol = { volumeId: "v-new", hostMountPath: `/mnt/ocd-${app.name}-op42`, volName: "x" };
    const out = (await step.run(ctx, { create_volume: vol })) as any;
    expect(out.priorMinReplicas).toBe(2);
    expect(out.priorMaxReplicas).toBe(5);
    expect(out.volumeMount).toBe(`/mnt/ocd-${app.name}-op42:/var/data`);
    const fresh = db.getApp(app.id)!;
    expect(fresh.volume_id).toBe("v-new");
    expect(fresh.min_replicas).toBe(1);
    expect(fresh.max_replicas).toBe(1);
  });

  test("compensate clears the volume, restores scaling, and recreates volume-less", async () => {
    const { app } = makeApp({ minReplicas: 3, maxReplicas: 4 });
    db.updateAppVolume(app.id, "v-x", "/mnt/y:/data");
    db.updateAppScaling(app.id, { min_replicas: 1, max_replicas: 1 });
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 });
    await step.compensate!(ctx, { priorMinReplicas: 3, priorMaxReplicas: 4, volumeMount: "/mnt/y:/data" }, {});
    const fresh = db.getApp(app.id)!;
    expect(fresh.volume_id).toBe("");
    expect(fresh.min_replicas).toBe(3);
    expect(fresh.max_replicas).toBe(4);
    expect(recreateAppContainer).toHaveBeenCalledWith(app.id, undefined, expect.anything());
  });
});

describe("attach_volume: recreate_container", () => {
  const step = stepByName("recreate_container");

  test("throws when recreateAppContainer fails", async () => {
    const { app } = makeApp();
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "boom" }));
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 });
    expect(step.run(ctx, { attach_to_app: { volumeMount: "/mnt/x:/data" } })).rejects.toThrow(/boom/);
  });
});

describe("attach_volume: full rollback on a failed recreate", () => {
  test("a failed recreate rolls back volume, scaling, bind mount and cloud volume", async () => {
    const { app, server } = makeApp({ minReplicas: 1, maxReplicas: 3 });
    const { ctx } = makeCtx({ appId: app.id, sizeGb: 10 }, 99);

    const validateOut = await stepByName("validate").run(ctx, {});
    const createOut = await stepByName("create_volume").run(ctx, { validate: validateOut });
    const attachOut = await stepByName("attach_to_app").run(ctx, { validate: validateOut, create_volume: createOut });
    const prior = { validate: validateOut, create_volume: createOut, attach_to_app: attachOut };

    // recreate_container fails -> the runner compensates the completed steps in
    // reverse (recreate_container itself has no compensate).
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "container failed" }));
    await expect(stepByName("recreate_container").run(ctx, prior)).rejects.toThrow(/container failed/);

    await stepByName("attach_to_app").compensate!(ctx, attachOut, prior);
    await stepByName("bind_mount").compensate!(ctx, { ok: true }, prior);
    await stepByName("create_volume").compensate!(ctx, createOut as any, prior);

    const fresh = db.getApp(app.id)!;
    expect(fresh.volume_id).toBe("");
    expect(fresh.min_replicas).toBe(1);
    expect(fresh.max_replicas).toBe(3);
    expect(removeVolumeBindMount).toHaveBeenCalled();
    expect(compute._mocks.volumeDetach).toHaveBeenCalled();
    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete.mock.calls[0][0]).toBe((createOut as any).volumeId);
    expect(server.location).toBe("fsn1"); // sanity: target server used
  });
});

describe("attach_volume: op structure", () => {
  test("kind, resource keys and step order", () => {
    expect(attachVolumeOp.kind).toBe("attach_volume");
    expect(attachVolumeOp.resourceKeys({ appId: 7 } as any)).toEqual(["app:7"]);
    expect(attachVolumeOp.steps.map((s) => s.name)).toEqual([
      "validate", "create_volume", "bind_mount", "attach_to_app", "recreate_container",
    ]);
  });
});
