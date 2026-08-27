import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const recreateAppContainer = mock(async () => ({ ok: true } as { ok: boolean; error?: string }));
mock.module("../deploy/index.ts", () => ({ recreateAppContainer }));

import * as db from "../../shared/db.ts";
import remountVolumeOp from "./remount-volume.ts";

function makeCtx(input: any) {
  return {
    opId: 77,
    kind: "remount_volume",
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

function stepByName(name: string) {
  const step = remountVolumeOp.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
}

function makeApp() {
  const server = db.insertServer({
    name: `srv-${randomSuffix()}`, provider_id: `h-${randomSuffix()}`, ipv4: "2.2.2.2", ipv6: "",
    type: "cx22", location: "fsn1", status: "ready",
  });
  const name = `rm-${randomSuffix()}`;
  const { app } = db.insertAppWithFirstReplica(
    { name, domain: `${name}.example.com`, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000, env_vars: "{}" },
    server.id,
  );
  db.updateAppVolume(app.id, "v-1", `/mnt/ocd-${name}-data:/old`, true);
  return db.getApp(app.id)!;
}

beforeEach(() => {
  recreateAppContainer.mockClear();
  recreateAppContainer.mockImplementation(async () => ({ ok: true }));
});

describe("remount_volume", () => {
  test("separates snapshot, DB update, and container convergence", async () => {
    const app = makeApp();
    const ctx = makeCtx({ appId: app.id, mountPath: "/new" });
    const v = await stepByName("validate").run(ctx, {});
    const prior = { validate: v };
    await stepByName("update_mount").run(ctx, prior);

    expect(db.getApp(app.id)!.volume_mount).toBe(`${app.volume_mount.split(":")[0]}:/new`);
    expect(recreateAppContainer).not.toHaveBeenCalled();

    await stepByName("recreate_container").run(ctx, prior);
    expect(recreateAppContainer).toHaveBeenCalledWith(app.id, (v as any).nextMount, expect.anything());
    expect(remountVolumeOp.steps.map((s) => s.name)).toEqual(["validate", "update_mount", "recreate_container"]);
    expect(stepByName("recreate_container").probe).toBeUndefined();
  });

  test("DB probe adopts only the exact mount and preserves provenance", async () => {
    const app = makeApp();
    const ctx = makeCtx({ appId: app.id, mountPath: "/new" });
    const v = await stepByName("validate").run(ctx, {}) as any;
    const prior = { validate: v };
    db.updateAppVolume(app.id, "v-1", v.nextMount, false);
    expect(await stepByName("update_mount").probe!(ctx, prior)).toBeNull();
    db.updateAppVolume(app.id, "v-1", v.nextMount, true);
    expect(await stepByName("update_mount").probe!(ctx, prior)).toEqual({ ok: true });
  });

  test("failed container convergence can compensate to the previous mount", async () => {
    const app = makeApp();
    const ctx = makeCtx({ appId: app.id, mountPath: "/new" });
    const v = await stepByName("validate").run(ctx, {}) as any;
    const prior = { validate: v };
    await stepByName("update_mount").run(ctx, prior);
    recreateAppContainer.mockImplementationOnce(async () => ({ ok: false, error: "new mount failed" }));
    await expect(stepByName("recreate_container").run(ctx, prior)).rejects.toThrow(/new mount failed/);

    recreateAppContainer.mockImplementationOnce(async () => ({ ok: true }));
    await stepByName("update_mount").compensate!(ctx, { ok: true }, prior);
    const restored = db.getApp(app.id)!;
    expect(restored.volume_mount).toBe(v.previousMount);
    expect(!!restored.volume_attached).toBe(true);
    expect(recreateAppContainer).toHaveBeenLastCalledWith(app.id, v.previousMount, expect.anything());
  });

  test("compensation reruns container restore after a crash instead of trusting DB alone", async () => {
    const app = makeApp();
    const ctx = makeCtx({ appId: app.id, mountPath: "/new" });
    const v = await stepByName("validate").run(ctx, {}) as any;
    const prior = { validate: v };
    db.updateAppVolume(app.id, v.volumeId, v.previousMount, v.volumeAttached);
    expect(stepByName("update_mount").probeCompensated).toBeUndefined();
    await stepByName("update_mount").compensate!(ctx, { ok: true }, prior);
    expect(recreateAppContainer).toHaveBeenCalledWith(app.id, v.previousMount, expect.anything());
  });
});
