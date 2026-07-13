import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const compute = makeFakeComputeProvider();
(compute as any).id = "test-cloud";
mock.module("../../shared/providers/index.ts", () => ({ hetzner: compute }));

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

const removeVolumeBindMount = mock(async () => {});
mock.module("../hetzner/host-mounts.ts", () => ({
  ensureVolumeBindMount: mock(async () => {}),
  removeVolumeBindMount,
}));
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const resizeVolume = mock(async () => {});
compute.volumes.resize = resizeVolume as any;

import * as db from "../../shared/db.ts";
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
    type: "cx22", location: "fsn1", status: "ready",
  });
  const name = `dv-${randomSuffix()}`;
  const { app } = db.insertAppWithFirstReplica(
    { name, domain: `${name}.example.com`, git_repo: "https://github.com/x/y", dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}" },
    server.id,
  );
  if (volumeId) db.updateAppVolume(app.id, volumeId, `/mnt/ocd-${name}-data:/data`);
  return { server, app: db.getApp(app.id)! };
}

beforeEach(() => {
  compute._mocks.volumeDetach.mockClear();
  resizeVolume.mockClear();
  recreateAppContainer.mockClear();
});

describe("detach_volume", () => {
  test("validate throws when the app has no volume", async () => {
    const { app } = makeAppWithVolume(null);
    const { ctx } = makeCtx({ appId: app.id });
    expect(stepByName(detachVolumeOp, "validate").run(ctx, {})).rejects.toThrow(/no volume attached/i);
  });

  test("detaches, clears the app row, and recreates without the volume (best-effort)", async () => {
    const { app } = makeAppWithVolume("v-9");
    const { ctx } = makeCtx({ appId: app.id });
    const v = await stepByName(detachVolumeOp, "validate").run(ctx, {});
    const prior = { validate: v };
    await stepByName(detachVolumeOp, "detach_volume").run(ctx, prior);
    await stepByName(detachVolumeOp, "clear_app_volume").run(ctx, prior);
    await stepByName(detachVolumeOp, "recreate_container").run(ctx, prior);
    expect(compute._mocks.volumeDetach).toHaveBeenCalledWith("v-9");
    expect(db.getApp(app.id)!.volume_id).toBe("");
    expect(recreateAppContainer).toHaveBeenCalledWith(app.id, undefined, expect.anything());
  });

  test("has no compensations (pure removal)", () => {
    expect(detachVolumeOp.steps.every((s) => !s.compensate)).toBe(true);
    expect(detachVolumeOp.steps.map((s) => s.name)).toEqual([
      "validate", "remove_bind_mount", "detach_volume", "clear_app_volume", "recreate_container",
    ]);
  });
});

describe("resize_volume", () => {
  test("resizes the volume and has no compensation", async () => {
    const { ctx } = makeCtx({ volumeId: "v-3", sizeGb: 50 });
    await stepByName(resizeVolumeOp, "resize_volume").run(ctx, {});
    expect(resizeVolume).toHaveBeenCalledWith("v-3", 50);
    expect(resizeVolumeOp.resourceKeys({ volumeId: "v-3", sizeGb: 50 })).toEqual(["volume:v-3"]);
    expect(resizeVolumeOp.steps[0].compensate).toBeUndefined();
  });
});
