import * as db from "../../shared/db.ts";
import { rollingRedeploy } from "../scale/index.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { hashEnvironment } from "../revision.ts";
import { registerOp } from "./registry.ts";
import {
  snapshotCurrentRevision,
  prepareEnvironment,
  pullTargetImage,
  swapContainer,
  syncIngressStep,
  healthCheckStep,
  discardRevisionSnapshot,
  type TargetOut,
} from "./rollback.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Promotion pulls and runs the exact immutable digest proven in the source
// environment. Source revisions are optional provenance only.
type PromoteInput = {
  appId: number; // DEST (production) app id — the app being mutated
  sourceAppId: number; // SOURCE (e.g. staging) app whose running commit we promote
  userId?: string;
};

// First step: resolve the artifact running in SOURCE and package it as the same
// `load_target_deployment` output the reused rollback steps consume — but
// targeting the DEST app and its server.
const loadPromotionTarget: Step<PromoteInput, TargetOut> = {
  name: "load_target_deployment",
  label: "Resolve source version",
  async run(ctx) {
    const dest = db.getApp(ctx.input.appId);
    if (!dest) throw new Error("Destination app not found");
    const source = db.getApp(ctx.input.sourceAppId);
    if (!source) throw new Error("Source app not found");
    if (source.id === dest.id) throw new Error("Source and destination must be different apps");

    const replicas = db.getReplicas(dest.id);
    if (replicas.length === 0) throw new Error("Destination app has no replicas");
    const first = replicas[0];

    // The version running in SOURCE = its most recent successful deployment.
    const sourceDeployment = db
      .getDeployments(source.id)
      .find((d) => d.status === "deployed");
    if (!sourceDeployment) {
      throw new Error(`Source app ${source.name} has no successful deployment to promote`);
    }
    const sourceCommit = sourceDeployment.git_commit || "";
    if (!sourceDeployment?.image_digest?.includes("@sha256:")) {
      throw new Error(`Source app ${source.name} has no immutable image digest to promote`);
    }

    if (ctx.input.userId) db.updateAppDeployedBy(dest.id, ctx.input.userId);
    db.appendDeployLog(
      dest.id,
      `[promote] Promoting ${source.name} image ${sourceDeployment.image_digest} → ${dest.name}`,
    );

    return {
      appId: dest.id,
      replicaId: first.id,
      serverId: first.server_id,
      gitCommit: sourceCommit,
      imageTag: sourceDeployment.image_digest,
      imageDigest: sourceDeployment?.image_digest || undefined,
      previousStatus: dest.status,
    };
  },
};

// Multi-replica: after swap_container pulls and swaps the first replica,
// mirror redeploy's rolling update to cover the rest. Each server pulls the
// same immutable registry digest and recreates its
// container one at a time (draining via ingress between). No-op for single
// replica. Mirrors redeploy.ts's roll_extra_replicas, including its compensate.
const rollExtraReplicas: Step<PromoteInput, { ok: true }> = {
  name: "roll_extra_replicas",
  label: "Roll extra replicas",
  async run(ctx, prior) {
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length <= 1) return { ok: true };
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("Destination app not found");
    const swap = prior["swap_container"] as { imageDigest: string };
    const envVars = await resolveAppEnvVars(app);
    const rolling = await rollingRedeploy(
      ctx.input.appId,
      (step, detail) => ctx.log(`[${step}] ${detail}`),
      {
        imageDigest: swap.imageDigest,
        envHash: hashEnvironment(envVars),
        configRevision: app.config_revision,
      },
    );
    if (!rolling.ok) throw new Error(`Promotion rolling update failed: ${rolling.error}`);
    return { ok: true };
  },
  async compensate(ctx) {
    // Rolling redeploy replaces replicas in-place; we can't undo the image swap,
    // but we can clear leftover 'draining' markers and re-sync ingress so
    // traffic stops routing to half-state replicas.
    try {
      const replicas = db.getReplicas(ctx.input.appId);
      for (const r of replicas) {
        if (r.status === "draining") {
          try { db.updateReplicaStatus(r.id, "running"); } catch { /* ignore */ }
        }
      }
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Failed to re-sync after roll_extra_replicas compensate: ${err}`);
    }
  },
};

const recordPromotion: Step<PromoteInput, { deploymentId: number }> = {
  name: "record_promotion",
  label: "Record promotion",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const swap = prior["swap_container"] as { imageDigest: string };
    const source = db.getApp(ctx.input.sourceAppId);
    const sourceName = source?.name ?? `app:${ctx.input.sourceAppId}`;
    const sourceDeployment = db.getLastSuccessfulDeployment(ctx.input.sourceAppId);
    // git_commit is the real promoted commit (a valid future rollback target);
    // the promotion provenance lives in `source`.
    const row = db.insertDeployment({
      operation_id: ctx.opId,
      app_id: target.appId,
      image_tag: target.imageTag,
      image_digest: swap.imageDigest,
      image_size_bytes: sourceDeployment?.image_size_bytes,
      archive_size_bytes: sourceDeployment?.archive_size_bytes,
      transfer_size_bytes: sourceDeployment?.transfer_size_bytes,
      git_commit: target.gitCommit,
      config_revision: db.getApp(target.appId)?.config_revision ?? 1,
      source: `promote-from-${sourceName}@${target.gitCommit}`,
    });
    db.updateAppImageRef(target.appId, swap.imageDigest);
    db.appendDeployLog(target.appId, `[done] Promoted ${sourceName} @ ${target.gitCommit}`);
    return { deploymentId: row.id };
  },
};

const promoteOp: OpKindDefinition<PromoteInput> = {
  kind: "promote",
  label: "Promote app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    loadPromotionTarget,
    snapshotCurrentRevision,
    prepareEnvironment,
    pullTargetImage,
    swapContainer,
    rollExtraReplicas,
    syncIngressStep,
    healthCheckStep,
    recordPromotion,
    discardRevisionSnapshot,
  ],
};

registerOp(promoteOp as OpKindDefinition<any>);

export default promoteOp;
export type { PromoteInput };
