import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";

const compute = makeFakeComputeProvider();
let observedProviderServerId: string | null = null;
compute.volumes.get = mock(async (id: string) => ({
  providerId: id,
  name: "v",
  sizeGb: 10,
  location: "fsn1",
  serverId: observedProviderServerId,
})) as any;
compute._mocks.volumeAttach.mockImplementation(async (_id: string, serverId: string) => {
  observedProviderServerId = serverId;
});
compute._mocks.volumeDetach.mockImplementation(async () => {
  observedProviderServerId = null;
});
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

const ensureVolumeBindMount = mock(async () => {});
const removeVolumeBindMount = mock(async () => {});

const realSleep = Bun.sleep;
(Bun as any).sleep = () => Promise.resolve();

import * as db from "../../shared/db.ts";
import reattachVolumeOp from "./reattach-volume.ts";
import { __setBindImplForTest, __resetBindImplForTest } from "./_volumes.ts";

afterAll(() => { (Bun as any).sleep = realSleep; });

function makeCtx(input: any, opId = 55) {
  const logLines: string[] = [];
  return {
    ctx: {
      opId,
      kind: "reattach_volume",
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
  const step = reattachVolumeOp.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
}

function makeApp(location: string, withVolume: string | null) {
  const server = db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "2.2.2.2",
    ipv6: "",
    type: "cx22",
    location,
    status: "ready",
  });
  const name = `ra-${randomSuffix()}`;
  const { app } = db.insertAppWithFirstReplica(
    { name, domain: `${name}.example.com`, git_repo: "https://github.com/x/y", dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}" },
    server.id,
  );
  if (withVolume) db.updateAppVolume(app.id, withVolume, `/mnt/ocd-${name}-data:/old`, true);
  return { server, app: db.getApp(app.id)! };
}

async function validateFor(from: ReturnType<typeof makeApp>, to: ReturnType<typeof makeApp>) {
  const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id, mountPath: "/new" });
  const v = await stepByName("validate").run(ctx, {});
  return { ctx, v: v as any, prior: { validate: v } };
}

beforeEach(() => {
  observedProviderServerId = null;
  compute._mocks.volumeAttach.mockClear();
  compute._mocks.volumeDetach.mockClear();
  recreateAppContainer.mockClear();
  recreateAppContainer.mockImplementation(async () => ({ ok: true }));
  ensureVolumeBindMount.mockClear();
  ensureVolumeBindMount.mockImplementation(async () => {});
  removeVolumeBindMount.mockClear();
  removeVolumeBindMount.mockImplementation(async () => {});
  __setBindImplForTest({ ensureVolumeBindMount, removeVolumeBindMount });
});

afterEach(() => __resetBindImplForTest());

describe("reattach_volume: validate", () => {
  test("captures the exact source state and computes the target mount", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { v } = await validateFor(from, to);
    expect(v.fromProviderServerId).toBe(from.server.provider_id);
    expect(v.fromVolumeMount).toBe(from.app.volume_mount);
    expect(v.fromVolumeAttached).toBe(true);
    expect(v.toProviderServerId).toBe(to.server.provider_id);
    expect(v.toVolumeMount).toBe(`/mnt/ocd-${to.app.name}-data:/new`);
  });

  test("rejects a location mismatch", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("nbg1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    expect(stepByName("validate").run(ctx, {})).rejects.toThrow(/Cannot reattach/i);
  });

  test("rejects a source that does not own the requested volume", async () => {
    const from = makeApp("fsn1", "v-other");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    expect(stepByName("validate").run(ctx, {})).rejects.toThrow(/does not own/i);
  });

  test("rejects when the target already has a volume", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", "v-2");
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    expect(stepByName("validate").run(ctx, {})).rejects.toThrow(/already has a volume/i);
  });
});

describe("reattach_volume: source transitions", () => {
  test("drains the container before clearing DB, unmounting, and detaching", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    observedProviderServerId = from.server.provider_id;
    const { ctx, prior } = await validateFor(from, to);

    await stepByName("recreate_source_without_volume").run(ctx, prior);
    expect(recreateAppContainer).toHaveBeenLastCalledWith(from.app.id, undefined, expect.anything());
    await stepByName("clear_source_app").run(ctx, prior);
    expect(db.getApp(from.app.id)!.volume_id).toBe("");
    await stepByName("remove_source_bind_mount").run(ctx, prior);
    await stepByName("detach_source_provider").run(ctx, prior);

    expect(removeVolumeBindMount).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDetach).toHaveBeenCalledWith("v-1");
    expect(observedProviderServerId).toBeNull();
  });

  test("a failed source drain restores the previous mounted container inline", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, v, prior } = await validateFor(from, to);
    recreateAppContainer
      .mockImplementationOnce(async () => ({ ok: false, error: "drain failed" }))
      .mockImplementationOnce(async () => ({ ok: true }));

    await expect(stepByName("recreate_source_without_volume").run(ctx, prior)).rejects.toThrow(/drain failed/);
    expect(recreateAppContainer).toHaveBeenLastCalledWith(from.app.id, v.fromVolumeMount, expect.anything());
  });

  test("source DB probe adopts only the fully cleared row", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, prior } = await validateFor(from, to);
    const step = stepByName("clear_source_app");
    expect(await step.probe!(ctx, prior)).toBeNull();
    db.updateAppVolume(from.app.id, "", "stale-mount");
    expect(await step.probe!(ctx, prior)).toBeNull();
    db.updateAppVolume(from.app.id, "", "");
    expect(await step.probe!(ctx, prior)).toEqual({ ok: true });
  });

  test("provider detach probe does not adopt a volume attached to an unexpected server", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, prior } = await validateFor(from, to);
    observedProviderServerId = "h-unexpected";
    const step = stepByName("detach_source_provider");
    expect(await step.probe!(ctx, prior)).toBeNull();
    await expect(step.run(ctx, prior)).rejects.toThrow(/unexpected server/i);
    expect(compute._mocks.volumeDetach).not.toHaveBeenCalled();
  });
});

describe("reattach_volume: target transitions", () => {
  test("attaches, binds, records, and recreates in separate steps", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, v, prior } = await validateFor(from, to);

    await stepByName("attach_target_provider").run(ctx, prior);
    await stepByName("bind_target_mount").run(ctx, prior);
    await stepByName("record_target_app").run(ctx, prior);
    await stepByName("recreate_target_with_volume").run(ctx, prior);

    expect(observedProviderServerId).toBe(to.server.provider_id);
    expect(db.getApp(to.app.id)!.volume_id).toBe("v-1");
    expect(db.getApp(to.app.id)!.volume_mount).toBe(v.toVolumeMount);
    expect(recreateAppContainer).toHaveBeenLastCalledWith(to.app.id, v.toVolumeMount, expect.anything());
  });

  test("target DB probe does not adopt an incomplete or wrong mount", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, v, prior } = await validateFor(from, to);
    const step = stepByName("record_target_app");
    db.updateAppVolume(to.app.id, "v-1", "/wrong:/mount", true);
    expect(await step.probe!(ctx, prior)).toBeNull();
    db.updateAppVolume(to.app.id, "v-1", v.toVolumeMount, true);
    expect(await step.probe!(ctx, prior)).toEqual({ ok: true });
    expect(stepByName("recreate_target_with_volume").probe).toBeUndefined();
  });

  test("a failed target recreate is restored volume-less by DB-step compensation", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, prior } = await validateFor(from, to);
    await stepByName("record_target_app").run(ctx, prior);
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "target down" }));
    await expect(stepByName("recreate_target_with_volume").run(ctx, prior)).rejects.toThrow(/target down/);

    recreateAppContainer.mockImplementationOnce(async () => ({ ok: true }));
    await stepByName("record_target_app").compensate!(ctx, { ok: true }, prior);
    expect(db.getApp(to.app.id)!.volume_id).toBe("");
    expect(recreateAppContainer).toHaveBeenLastCalledWith(to.app.id, undefined, expect.anything());
  });
});

describe("reattach_volume: rollback", () => {
  test("reverse compensations restore provider, bind, DB provenance, and previous mount", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    observedProviderServerId = from.server.provider_id;
    const { ctx, v, prior } = await validateFor(from, to);

    await stepByName("recreate_source_without_volume").run(ctx, prior);
    await stepByName("clear_source_app").run(ctx, prior);
    await stepByName("remove_source_bind_mount").run(ctx, prior);
    await stepByName("detach_source_provider").run(ctx, prior);
    await stepByName("attach_target_provider").run(ctx, prior);
    await stepByName("bind_target_mount").run(ctx, prior);
    await stepByName("record_target_app").run(ctx, prior);

    await stepByName("record_target_app").compensate!(ctx, { ok: true }, prior);
    await stepByName("bind_target_mount").compensate!(ctx, { ok: true }, prior);
    await stepByName("attach_target_provider").compensate!(ctx, { ok: true }, prior);
    await stepByName("detach_source_provider").compensate!(ctx, { ok: true }, prior);
    await stepByName("remove_source_bind_mount").compensate!(ctx, { ok: true }, prior);
    await stepByName("clear_source_app").compensate!(ctx, { ok: true }, prior);
    await stepByName("recreate_source_without_volume").compensate!(ctx, { ok: true }, prior);

    const restored = db.getApp(from.app.id)!;
    expect(observedProviderServerId).toBe(from.server.provider_id);
    expect(restored.volume_id).toBe("v-1");
    expect(restored.volume_mount).toBe(v.fromVolumeMount);
    expect(!!restored.volume_attached).toBe(v.fromVolumeAttached);
    expect(db.getApp(to.app.id)!.volume_id).toBe("");
    expect(recreateAppContainer).toHaveBeenLastCalledWith(from.app.id, v.fromVolumeMount, expect.anything());
  });

  test("source provider compensation can resume after attach succeeded before its step record", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx, prior } = await validateFor(from, to);
    observedProviderServerId = from.server.provider_id;
    const step = stepByName("detach_source_provider");
    expect(await step.probeCompensated!(ctx, { ok: true }, prior)).toBe(true);
    await step.compensate!(ctx, { ok: true }, prior);
    expect(compute._mocks.volumeAttach).not.toHaveBeenCalled();
  });
});

describe("reattach_volume: op structure", () => {
  test("uses durable transition boundaries", () => {
    expect(reattachVolumeOp.resourceKeys({ volumeId: "v-3", fromAppId: 3, toAppId: 8 } as any)).toEqual([
      "app:3", "app:8", "volume:v-3",
    ]);
    expect(reattachVolumeOp.steps.map((s) => s.name)).toEqual([
      "validate",
      "recreate_source_without_volume",
      "clear_source_app",
      "remove_source_bind_mount",
      "detach_source_provider",
      "attach_target_provider",
      "bind_target_mount",
      "record_target_app",
      "recreate_target_with_volume",
    ]);
  });
});
