import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const compute = makeFakeComputeProvider();
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const resizeVolume = mock(async (_id: string, _size: number) => {});
compute.volumes.resize = resizeVolume as any;
let observedVolumeSize = 10;
let observedVolumeServerId: string | null = null;
compute.volumes.get = mock(async (id: string) => ({
  providerId: id,
  name: "v",
  sizeGb: observedVolumeSize,
  location: "fsn1",
  serverId: observedVolumeServerId,
})) as any;
resizeVolume.mockImplementation(async (_id: string, size: number) => {
  observedVolumeSize = size;
});

import * as db from "../../shared/db.ts";
import { __replaceInfrastructureProvidersForTest } from "../../shared/providers/registry.ts";
import detachVolumeOp from "./detach-volume.ts";
import resizeVolumeOp from "./resize-volume.ts";

function makeCtx(input: any) {
  const logLines: string[] = [];
  return {
    ctx: {
      opId: 1, kind: "x", input, trigger: "ui" as const, triggeredBy: "", parentId: null, attempt: 1,
      isCancelRequested: () => false, log: (l: string) => logLines.push(l), park: () => {}, unpark: () => {},
    } as any,
    logLines,
  };
}

function stepByName(op: { steps: any[] }, name: string) {
  const step = op.steps.find((s: any) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
}

function makeAppWithVolume(volumeId: string | null) {
  const server = db.insertServer({
    name: `srv-${randomSuffix()}`, provider_id: `h-${randomSuffix()}`, ipv4: "2.2.2.2", ipv6: "",
    type: "cx22", location: "fsn1", status: "ready", provider: "hetzner", ownership: "managed",
  });
  const name = `dv-${randomSuffix()}`;
  const { app } = db.insertAppWithFirstReplica(
    { name, domain: `${name}.example.com`, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000, env_vars: "{}" },
    server.id,
  );
  if (volumeId) db.updateAppVolume(app.id, volumeId, `/mnt/ocd-${name}-data:/data`, false, "hetzner-block");
  return { server, app: db.getApp(app.id)! };
}

beforeEach(() => {
  __replaceInfrastructureProvidersForTest([compute]);
  observedVolumeSize = 10;
  observedVolumeServerId = null;
  compute._mocks.volumeDetach.mockClear();
  compute._mocks.volumeDetach.mockImplementation(async () => { observedVolumeServerId = null; });
  resizeVolume.mockClear();
  recreateAppContainer.mockClear();
});

describe("detach_volume", () => {
  test("validate throws when the app has no volume", async () => {
    const { app } = makeAppWithVolume(null);
    const { ctx } = makeCtx({ appId: app.id });
    expect(stepByName(detachVolumeOp, "validate").run(ctx, {})).rejects.toThrow(/no volume attached/i);
  });

  test("confirms detach, retains the volume, clears the app row, and recreates", async () => {
    const { server, app } = makeAppWithVolume("v-9");
    observedVolumeServerId = server.provider_id;
    const { ctx } = makeCtx({ appId: app.id });
    const v = await stepByName(detachVolumeOp, "validate").run(ctx, {});
    const prior = { validate: v };
    await stepByName(detachVolumeOp, "detach_volume").run(ctx, prior);
    await stepByName(detachVolumeOp, "clear_app_volume").run(ctx, prior);
    await stepByName(detachVolumeOp, "recreate_container").run(ctx, prior);
    expect(compute._mocks.volumeDetach).toHaveBeenCalledWith("v-9");
    expect(db.getApp(app.id)!.volume_id).toBe("");
    expect(db.getRetiredVolumes().some((row) => row.provider_volume_id === "v-9")).toBe(true);
    expect(recreateAppContainer).toHaveBeenCalledWith(app.id, undefined, expect.anything());
  });

  test("has no compensations (pure removal)", () => {
    expect(detachVolumeOp.steps.every((s) => !s.compensate)).toBe(true);
    expect(detachVolumeOp.steps.map((s) => s.name)).toEqual([
      "validate", "remove_bind_mount", "detach_volume", "clear_app_volume", "recreate_container", "assert_cleanup",
    ]);
  });

  test("fails the cleanup gate when container recreation was incomplete", async () => {
    const { app } = makeAppWithVolume("v-gate");
    const { ctx } = makeCtx({ appId: app.id });
    const gate = stepByName(detachVolumeOp, "assert_cleanup");

    await expect(gate.run(ctx, {
      remove_bind_mount: { ok: true },
      recreate_container: { ok: false },
    })).rejects.toThrow(/cleanup incomplete/i);
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });
});

describe("resize_volume", () => {
  test("resizes the volume and has no compensation", async () => {
    const { server } = makeAppWithVolume("v-3");
    const { ctx } = makeCtx({ volumeId: "v-3", sizeGb: 50, driverId: "hetzner-block", serverId: server.id });
    await stepByName(resizeVolumeOp, "resize_volume").run(ctx, {});
    expect(resizeVolume).toHaveBeenCalledWith("v-3", 50);
    expect(resizeVolumeOp.resourceKeys({ volumeId: "v-3", sizeGb: 50 })).toEqual(["volume:v-3"]);
    expect(resizeVolumeOp.steps[0].compensate).toBeUndefined();
  });
});
