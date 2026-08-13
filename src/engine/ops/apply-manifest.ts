import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import type { DeployRequest } from "../../shared/rpc.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { hashEnvironment } from "../revision.ts";

type ApplyManifestInput = {
  appId: number;
  userId?: string;
  deploy: boolean;
  spec?: DeployRequest;
  rollout?: "control" | "runtime" | "build";
  /** Desired source/build config was persisted without building it. */
  pendingRollout?: boolean;
};
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
    const rollout = ctx.input.rollout ?? (ctx.input.deploy ? "build" : "control");
    if (ctx.input.pendingRollout) db.requestAppRollout(app.id);
    if (ctx.input.spec && rollout === "build") {
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
    } else if (ctx.input.spec) {
      childOpIds.push(await runChild(
        ctx,
        "apply-config",
        "apply_app_config",
        [`app:${app.id}`],
        { appId: app.id, userId: ctx.input.userId, spec: ctx.input.spec },
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

    if (rollout === "runtime") {
      childOpIds.push(await runChild(
        ctx,
        "runtime-recreate",
        "reload_app",
        [`app:${app.id}`],
        { appId: app.id, force: true },
      ));
      app = db.getApp(ctx.input.appId)!;
      const priorDeployment = db.getDeployments(app.id).find((row) => row.status === "deployed");
      if (priorDeployment) {
        db.insertDeployment({
          app_id: app.id,
          operation_id: ctx.opId,
          image_tag: priorDeployment.image_tag,
          image_digest: priorDeployment.image_digest,
          env_hash: hashEnvironment(await resolveAppEnvVars(app)),
          git_commit: priorDeployment.git_commit,
          config_revision: app.config_revision,
          source: "manifest-runtime",
          image_size_bytes: priorDeployment.image_size_bytes,
          archive_size_bytes: 0,
          transfer_size_bytes: 0,
        });
        if (!ctx.input.pendingRollout) db.clearAppRolloutRequest(app.id, app.config_revision);
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
