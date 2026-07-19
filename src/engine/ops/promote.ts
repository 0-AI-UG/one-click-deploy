import * as db from "../../shared/db.ts";
import { rollingRedeploy } from "../scale/index.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { registerOp } from "./registry.ts";
import {
  checkoutTarget,
  rebuildImage,
  swapContainer,
  syncIngressStep,
  healthCheckStep,
  type TargetOut,
} from "./rollback.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Promote = "redeploy the DEST (production) app pinned to the exact git commit
// currently running in the SOURCE (staging) app". There is no registry: images
// are built on-host as `<app>:latest`, so version identity is the git commit.
// This op therefore checks out the source's commit in the DEST repo, rebuilds
// `<dest>:latest`, and swaps the DEST container(s) — exactly the rollback
// machinery, which it imports rather than duplicates.
type PromoteInput = {
  appId: number; // DEST (production) app id — the app being mutated
  sourceAppId: number; // SOURCE (e.g. staging) app whose running commit we promote
  userId?: string;
};

// First step: resolve the commit running in SOURCE and package it as the same
// `load_target_deployment` output the reused rollback steps consume — but
// targeting the DEST app + its server, and pinning `<dest>:latest` as the image
// tag the rebuild/record steps use.
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
    const sourceCommit = db
      .getDeployments(source.id)
      .find((d) => d.status === "deployed")?.git_commit;
    if (!sourceCommit) {
      throw new Error(`Source app ${source.name} has no successful deployment to promote`);
    }

    if (ctx.input.userId) db.updateAppDeployedBy(dest.id, ctx.input.userId);
    db.appendDeployLog(
      dest.id,
      `[promote] Promoting ${source.name} @ ${sourceCommit} → ${dest.name}`,
    );

    return {
      appId: dest.id,
      replicaId: first.id,
      serverId: first.server_id,
      gitCommit: sourceCommit,
      imageTag: `${dest.name}:latest`,
      previousStatus: dest.status,
    };
  },
};

// Multi-replica: after swap_container rebuilds `<dest>:latest` and swaps the
// first replica, mirror redeploy's rolling update to cover the rest — it
// transfers the freshly built image to each other server and recreates its
// container one at a time (draining via ingress between). No-op for single
// replica. Mirrors redeploy.ts's roll_extra_replicas, including its compensate.
const rollExtraReplicas: Step<PromoteInput, { ok: true }> = {
  name: "roll_extra_replicas",
  label: "Roll extra replicas",
  async run(ctx) {
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length <= 1) return { ok: true };
    const rolling = await rollingRedeploy(ctx.input.appId, (step, detail) => ctx.log(`[${step}] ${detail}`));
    if (!rolling.ok) db.appendDeployLog(ctx.input.appId, `[promote] Rolling update warning: ${rolling.error}`);
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
    const source = db.getApp(ctx.input.sourceAppId);
    const sourceName = source?.name ?? `app:${ctx.input.sourceAppId}`;
    // git_commit is the real promoted commit (a valid future rollback target);
    // the promotion provenance lives in `source`.
    const row = db.insertDeployment({
      app_id: target.appId,
      image_tag: target.imageTag,
      git_commit: target.gitCommit,
      source: `promote-from-${sourceName}@${target.gitCommit}`,
    });
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
    checkoutTarget,
    rebuildImage,
    swapContainer,
    rollExtraReplicas,
    syncIngressStep,
    healthCheckStep,
    recordPromotion,
  ],
};

registerOp(promoteOp as OpKindDefinition<any>);

export default promoteOp;
export type { PromoteInput };
