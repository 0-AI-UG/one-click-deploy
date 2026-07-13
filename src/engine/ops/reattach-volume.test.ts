import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const compute = makeFakeComputeProvider();
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

const ensureVolumeBindMount = mock(async () => {});
const removeVolumeBindMount = mock(async () => {});
mock.module("../hetzner/host-mounts.ts", () => ({ ensureVolumeBindMount, removeVolumeBindMount }));

// Neutralise the Hetzner automount wait in the bind path. Safe because bun runs
// test files sequentially in one process — restored in afterAll below.
const realSleep = Bun.sleep;
(Bun as any).sleep = () => Promise.resolve();

import * as db from "../../shared/db.ts";
import reattachVolumeOp from "./reattach-volume.ts";
import { afterAll } from "bun:test";

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
  if (withVolume) db.updateAppVolume(app.id, withVolume, `/mnt/ocd-${name}-data:/data`);
  return { server, app: db.getApp(app.id)! };
}

beforeEach(() => {
  compute._mocks.volumeAttach.mockClear();
  compute._mocks.volumeDetach.mockClear();
  recreateAppContainer.mockClear();
  recreateAppContainer.mockImplementation(async () => ({ ok: true }));
});

describe("reattach_volume: validate", () => {
  const step = stepByName("validate");

  test("computes source + target mount paths", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id, mountPath: "/data" });
    const out = (await step.run(ctx, {})) as any;
    expect(out.fromProviderServerId).toBe(from.server.provider_id);
    expect(out.toProviderServerId).toBe(to.server.provider_id);
    expect(out.toHostMountPath).toBe(`/mnt/ocd-${to.app.name}-data`);
    expect(out.toVolumeMount).toBe(`/mnt/ocd-${to.app.name}-data:/data`);
  });

  test("rejects a location mismatch", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("nbg1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    expect(step.run(ctx, {})).rejects.toThrow(/Cannot reattach/i);
  });

  test("rejects when the target already has a volume", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", "v-2");
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    expect(step.run(ctx, {})).rejects.toThrow(/already has a volume/i);
  });
});

describe("reattach_volume: detach_from_source", () => {
  const step = stepByName("detach_from_source");

  test("detaches, clears the source app row, and recreates volume-less", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    const v = (await stepByName("validate").run(ctx, {})) as any;
    await step.run(ctx, { validate: v });
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(1);
    expect(db.getApp(from.app.id)!.volume_id).toBe("");
    expect(recreateAppContainer).toHaveBeenCalledWith(from.app.id, undefined, expect.anything());
  });

  test("compensate re-attaches the volume back to the source", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id });
    const v = (await stepByName("validate").run(ctx, {})) as any;
    db.updateAppVolume(from.app.id, "", ""); // simulate detached state
    await step.compensate!(ctx, { ok: true }, { validate: v });
    expect(compute._mocks.volumeAttach).toHaveBeenCalledWith("v-1", from.server.provider_id);
    expect(db.getApp(from.app.id)!.volume_id).toBe("v-1");
    expect(recreateAppContainer).toHaveBeenCalledWith(from.app.id, v.fromVolumeMount, expect.anything());
  });
});

describe("reattach_volume: attach_to_target", () => {
  const step = stepByName("attach_to_target");

  test("attaches, binds, records and recreates on the target (happy path)", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id, mountPath: "/data" });
    const v = (await stepByName("validate").run(ctx, {})) as any;
    await step.run(ctx, { validate: v });
    expect(compute._mocks.volumeAttach).toHaveBeenCalledWith("v-1", to.server.provider_id);
    expect(db.getApp(to.app.id)!.volume_id).toBe("v-1");
  });

  test("inline-cleans its own partial work when the target recreate fails", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id, mountPath: "/data" });
    const v = (await stepByName("validate").run(ctx, {})) as any;
    // First recreate (target, with volume) fails; second (rollback, volume-less) succeeds.
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "target down" }));
    await expect(step.run(ctx, { validate: v })).rejects.toThrow(/target down/);
    // Target row cleared and the volume detached from the target so the source
    // re-attach (detach_from_source.compensate) can succeed.
    expect(db.getApp(to.app.id)!.volume_id).toBe("");
    expect(compute._mocks.volumeDetach).toHaveBeenCalledWith("v-1");
  });
});

describe("reattach_volume: full rollback to source when the target fails", () => {
  test("volume ends back on the source, both apps consistent", async () => {
    const from = makeApp("fsn1", "v-1");
    const to = makeApp("fsn1", null);
    const { ctx } = makeCtx({ volumeId: "v-1", fromAppId: from.app.id, toAppId: to.app.id, mountPath: "/data" });

    const v = (await stepByName("validate").run(ctx, {})) as any;
    await stepByName("detach_from_source").run(ctx, { validate: v });
    expect(db.getApp(from.app.id)!.volume_id).toBe("");

    // attach_to_target fails (and inline-cleans its partial work).
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "target down" }));
    await expect(stepByName("attach_to_target").run(ctx, { validate: v })).rejects.toThrow(/target down/);

    // The runner then compensates detach_from_source -> volume back on source.
    await stepByName("detach_from_source").compensate!(ctx, { ok: true }, { validate: v });

    expect(db.getApp(from.app.id)!.volume_id).toBe("v-1");
    expect(db.getApp(to.app.id)!.volume_id).toBe("");
    expect(compute._mocks.volumeAttach).toHaveBeenLastCalledWith("v-1", from.server.provider_id);
  });
});

describe("reattach_volume: op structure", () => {
  test("kind, resource keys and step order", () => {
    expect(reattachVolumeOp.kind).toBe("reattach_volume");
    expect(reattachVolumeOp.resourceKeys({ fromAppId: 3, toAppId: 8 } as any)).toEqual(["app:3", "app:8"]);
    expect(reattachVolumeOp.steps.map((s) => s.name)).toEqual([
      "validate", "detach_from_source", "attach_to_target",
    ]);
  });
});
