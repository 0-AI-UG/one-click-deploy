import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import type { DeployRequest } from "../../shared/rpc.ts";

type ApplyManifestInput = { appId: number; userId?: string; deploy: boolean; spec?: DeployRequest };
type ApplyOut = { childOpIds: number[] };

async function runChild(
  ctx: OpContext<ApplyManifestInput>,
  suffix: string,
  kind: string,
  resourceKeys: string[],
  input: Record<string, unknown>,
): Promise<number> {
  const idempotencyKey = `manifest:${ctx.opId}:${suffix}`;
  const existing = listChildOperations(ctx.opId).find((op) => op.idempotency_key === idempotencyKey);
  const child = existing ?? enqueueOperation({
    kind,
    resourceKeys,
    input,
    trigger: "manifest",
    triggeredBy: ctx.triggeredBy,
    parentId: ctx.opId,
    idempotencyKey,
  });
  await awaitChildren(ctx, { childIds: [child.id] });
  return child.id;
}

function containerMountPath(volumeMount: string): string {
  const separator = volumeMount.indexOf(":");
  return separator < 0 ? "" : volumeMount.slice(separator + 1);
}

const reconcile: Step<ApplyManifestInput, ApplyOut> = {
  name: "reconcile_manifest",
  label: "Reconcile manifest state",
  async run(ctx) {
    const childOpIds: number[] = [];
    let app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (ctx.input.deploy && ctx.input.spec) {
      childOpIds.push(await runChild(
        ctx,
        "candidate-redeploy",
        "redeploy",
        [`app:${app.id}`],
        {
          appId: app.id,
          userId: ctx.input.userId,
          gitSha: ctx.input.spec.git_sha,
          candidate: ctx.input.spec,
        },
      ));
      app = db.getApp(ctx.input.appId)!;
    }
    const desiredId = app.desired_volume_id || "";
    const desiredSize = app.desired_volume_size;
    const desiredPath = app.desired_volume_path || "/data";
    if (desiredSize < 0) throw new Error("The app volume predates manifest ownership; deploy a manifest with explicit volume state");

    const wantsVolume = desiredSize > 0;
    const wrongVolume = !!app.volume_id && (
      (desiredId && app.volume_id !== desiredId) ||
      (!desiredId && !!app.volume_attached)
    );
    if (app.volume_id && (!wantsVolume || wrongVolume)) {
      childOpIds.push(await runChild(
        ctx,
        "detach",
        "detach_volume",
        [`app:${app.id}`, `volume:${app.volume_id}`],
        { appId: app.id },
      ));
      app = db.getApp(ctx.input.appId)!;
    }

    if (wantsVolume && !app.volume_id) {
      if (desiredId) {
        childOpIds.push(await runChild(
          ctx,
          "adopt",
          "attach_existing_volume",
          [`app:${app.id}`, `volume:${desiredId}`],
          { appId: app.id, volumeId: desiredId, mountPath: desiredPath },
        ));
      } else {
        childOpIds.push(await runChild(
          ctx,
          "create",
          "attach_volume",
          [`app:${app.id}`],
          { appId: app.id, sizeGb: desiredSize, mountPath: desiredPath },
        ));
      }
      app = db.getApp(ctx.input.appId)!;
    }

    if (wantsVolume && app.volume_id) {
      childOpIds.push(await runChild(
        ctx,
        "resize",
        "resize_volume",
        [`volume:${app.volume_id}`],
        { volumeId: app.volume_id, sizeGb: desiredSize },
      ));
      app = db.getApp(ctx.input.appId)!;
      if (containerMountPath(app.volume_mount) !== desiredPath) {
        childOpIds.push(await runChild(
          ctx,
          "remount",
          "remount_volume",
          [`app:${app.id}`, `volume:${app.volume_id}`],
          { appId: app.id, mountPath: desiredPath },
        ));
      }
    }

    if (ctx.input.deploy && !ctx.input.spec) {
      childOpIds.push(await runChild(
        ctx,
        "redeploy",
        "redeploy",
        [`app:${app.id}`],
        { appId: app.id, userId: ctx.input.userId },
      ));
    }
    return { childOpIds };
  },
};

const applyManifestOp: OpKindDefinition<ApplyManifestInput> = {
  kind: "apply_manifest",
  label: "Apply app manifest",
  resourceKeys: (input) => [`manifest:${input.appId}`],
  steps: [reconcile],
};

registerOp(applyManifestOp as OpKindDefinition<any>);
export default applyManifestOp;
export type { ApplyManifestInput };
