import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { awaitChildren } from "./_children.ts";
import { topoLevels } from "./deploy-stack.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

// Bulk promote: for every production member of a stack that has a webhook
// staging sibling holding a deployed commit, run the existing per-app `promote`
// op as a child. No promotion logic lives here — this op only decides WHICH
// members are promotable and fans out.
type PromoteStackInput = { stackId: number; userId?: string };

/** One member of the stack that can be promoted right now. */
export type Promotion = {
  appId: number;      // DEST (production) member
  appName: string;
  sourceAppId: number; // its staging sibling
  sourceAppName: string;
  commit: string;      // the sibling's currently-deployed commit
};

/** A member that was considered but cannot be promoted, plus why. */
export type Skip = { appName: string; reason: string };

export type PromotionPlan = { promotions: Promotion[]; skipped: Skip[]; levels?: Promotion[][] };

/**
 * Decide which stack members are promotable. Pure over its injected lookups so
 * the selection rules are unit-testable:
 *  - members that are themselves deploy targets (`target` of 'staging'/'dev')
 *    are not production apps and are skipped silently — they ARE the siblings;
 *  - a member with staging turned OFF is skipped even if a sibling row survives;
 *  - a member with no staging sibling has nothing to promote;
 *  - a member whose sibling has no successful deployment is skipped rather than
 *    promoted, because the child `promote` op would throw and fail the whole
 *    batch over one un-deployed sibling.
 */
export function planPromotions(
  members: AppRow[],
  siblingOf: (appId: number) => AppRow | null,
  deployedCommitOf: (appId: number) => string | null,
): PromotionPlan {
  const promotions: Promotion[] = [];
  const skipped: Skip[] = [];
  for (const member of members) {
    // Staging/dev rows ARE the siblings, not promotion destinations. `target` is
    // '' | 'production' | 'staging' | 'dev'; `target_of` points at the prod app.
    if (member.target_of != null) continue;
    if (member.target === "staging" || member.target === "dev") continue;
    // Staging OFF: turning it off (dropping webhook.staging, or clearing the
    // stack's staging_environment) nulls this column but LEAVES the sibling row and
    // its deployment history behind. Promoting from that stale sibling would
    // silently roll production back to whatever it last held, so an existing
    // sibling is not on its own a licence to promote.
    if (member.webhook_staging_environment_id == null) {
      skipped.push({ appName: member.name, reason: "webhook staging is off" });
      continue;
    }
    const sibling = siblingOf(member.id);
    if (!sibling) {
      skipped.push({ appName: member.name, reason: "no staging sibling" });
      continue;
    }
    const commit = deployedCommitOf(sibling.id);
    if (!commit) {
      skipped.push({ appName: member.name, reason: `${sibling.name} has no successful deployment` });
      continue;
    }
    promotions.push({
      appId: member.id,
      appName: member.name,
      sourceAppId: sibling.id,
      sourceAppName: sibling.name,
      commit,
    });
  }
  return { promotions, skipped };
}

/** A stack member's key is its fleet-global name minus the `<stack>-` prefix
 *  deploy_stack gave it. Falls back to the whole name if the prefix is missing
 *  (e.g. a member renamed out of the namespace) — such a key simply matches no
 *  `needs` entry and sorts as an independent node. */
export function memberKeyOf(stackName: string, appName: string): string {
  const prefix = `${stackName}-`;
  return appName.startsWith(prefix) ? appName.slice(prefix.length) : appName;
}

/**
 * Group the promotable members into dependency levels, using the `needs` edges
 * deploy_stack persisted on each member (`apps.stack_needs`). Members inside a
 * level are independent of one another and may promote concurrently; each level
 * must finish before the next starts.
 *
 * Degrades to today's single concurrent batch whenever ordering is not
 * knowable: nobody has persisted edges (every member predates migration 84),
 * or two members collapse to the same key. Throws on a cycle — the caller
 * decides whether that is fatal.
 */
export function orderPromotions(
  promotions: Promotion[],
  stackName: string,
  needsOf: (p: Promotion) => string[],
): Promotion[][] {
  if (promotions.length <= 1) return promotions.length > 0 ? [promotions] : [];
  const byKey = new Map<string, Promotion>();
  const nodes: Array<{ key: string; needs: string[] }> = [];
  for (const p of promotions) {
    const key = memberKeyOf(stackName, p.appName);
    if (byKey.has(key)) return [promotions]; // ambiguous keys — cannot order
    byKey.set(key, p);
    nodes.push({ key, needs: needsOf(p) });
  }
  // No persisted edges at all: preserve the pre-migration-84 behaviour exactly
  // rather than pretending to an ordering we don't have.
  if (nodes.every((n) => n.needs.length === 0)) return [promotions];
  return topoLevels(nodes).map((level) => level.map((k) => byKey.get(k)!));
}

const plan: Step<PromoteStackInput, PromotionPlan & { stackName: string }> = {
  name: "plan",
  label: "Plan stack promotion",
  async run(ctx) {
    const { stackId } = ctx.input;
    const stack = db.getStack(stackId);
    if (!stack) throw new Error(`Stack ${stackId} not found`);

    const members = db.getAppsByStackId(stackId);
    const { promotions, skipped } = planPromotions(
      members,
      (id) => db.getStagingSibling(id),
      db.getDeployedCommit,
    );

    if (promotions.length === 0) {
      throw new Error(
        `Stack "${stack.name}" has nothing to promote: no member has a staging sibling with a successful deployment.`,
      );
    }
    // Persist the dependency order in the completed plan output. Recomputing
    // from mutable app rows during a retry could enqueue a different order
    // than the one the user originally approved.
    const levels = orderPromotions(promotions, stack.name, (promotion) => {
      const app = db.getApp(promotion.appId);
      return db.parseStackNeeds(app?.stack_needs);
    });
    for (const s of skipped) {
      db.appendStackLog(stackId, `[promote] skipping ${s.appName}: ${s.reason}`);
      ctx.log(`skipping ${s.appName}: ${s.reason}`);
    }
    db.appendStackLog(
      stackId,
      `[promote] promoting ${promotions.length} member(s): ${promotions.map((p) => p.appName).join(", ")}`,
    );
    return { stackName: stack.name, promotions, skipped, levels };
  },
};

const promoteMembers: Step<PromoteStackInput, { childIds: number[] }> = {
  name: "promote_members",
  label: "Promote members",
  async run(ctx, prior) {
    const { stackId, userId } = ctx.input;
    const { promotions, stackName, levels: plannedLevels } = prior["plan"] as PromotionPlan & { stackName: string };
    const byKey = new Map(
      listChildOperations(ctx.opId).map((c) => [c.idempotency_key ?? "", c]),
    );
    const allChildIds: number[] = [];

    // Stack `needs` edges are persisted per member in `apps.stack_needs` (see
    // migration 84), so a promotion CAN be dependency-ordered: members promote
    // level by level, each level fully finished before the next starts, so two
    // members that depend on each other never sit on mismatched versions for
    // longer than one member's promotion. Members deployed before that column
    // existed carry no edges and fall back to one concurrent batch — exactly
    // the old behaviour.
    const levels = plannedLevels ?? orderPromotions(promotions, stackName, (p) => {
        const app = db.getApp(p.appId);
        return db.parseStackNeeds(app?.stack_needs);
      });

    for (const [i, level] of levels.entries()) {
      const childIds: number[] = [];
      for (const p of level) {
        const idk = `promote_stack:${ctx.opId}:app:${p.appId}`;
        const prev = byKey.get(idk);
        if (prev) { childIds.push(prev.id); continue; }
        const op = enqueueOperation({
          kind: "promote",
          resourceKeys: [`app:${p.appId}`],
          input: { appId: p.appId, sourceAppId: p.sourceAppId, userId },
          trigger: "stack",
          triggeredBy: ctx.triggeredBy,
          parentId: ctx.opId,
          idempotencyKey: idk,
        });
        childIds.push(op.id);
        db.appendStackLog(stackId, `[promote] ${p.sourceAppName} @ ${p.commit} → ${p.appName}`);
      }
      allChildIds.push(...childIds);
      if (levels.length > 1) {
        db.appendStackLog(
          stackId,
          `[promote] level ${i + 1}/${levels.length}: ${level.map((p) => p.appName).join(", ")}`,
        );
      }
      ctx.log(
        `promoting level ${i + 1}/${levels.length}: ${childIds.length} member(s) concurrently`,
      );
      await awaitChildren(ctx, { childIds });
    }
    return { childIds: allChildIds };
  },
  // No compensate: each child `promote` op rolls itself back on failure, and a
  // succeeded member's promotion is a legitimate production state we must not
  // undo behind the user's back.
};

const finalize: Step<PromoteStackInput, { promoted: number }> = {
  name: "finalize",
  label: "Finalize promotion",
  async run(ctx, prior) {
    const { stackId } = ctx.input;
    const { promotions, stackName } = prior["plan"] as PromotionPlan & { stackName: string };
    db.appendStackLog(stackId, `[done] promoted ${promotions.length} member(s) of stack "${stackName}"`);
    ctx.log(`promoted ${promotions.length} member(s)`);
    return { promoted: promotions.length };
  },
};

const promoteStackOp: OpKindDefinition<PromoteStackInput> = {
  kind: "promote_stack",
  label: "Promote stack",
  // Same key shape as destroy_stack so the dashboard's `stack:<id>` busy-state
  // helper picks this op up.
  resourceKeys: (input) => [`stack:${input.stackId}`],
  steps: [plan, promoteMembers, finalize],
};

registerOp(promoteStackOp as OpKindDefinition<any>);

export default promoteStackOp;
export type { PromoteStackInput };
