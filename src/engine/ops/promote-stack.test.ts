import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations, markOperationFinished } from "../../shared/db/operations.ts";
import promoteStackOp, { planPromotions, orderPromotions, memberKeyOf } from "./promote-stack.ts";
import type { Promotion } from "./promote-stack.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { OpContext } from "../types.ts";

type Input = { stackId: number; userId?: string };

function makeCtx(input: Input): OpContext<Input> {
  return {
    opId: 1,
    kind: "promote_stack",
    input,
    trigger: "test",
    triggeredBy: "tester",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  };
}

const planStep = promoteStackOp.steps.find((s) => s.name === "plan")!;
const promoteMembersStep = promoteStackOp.steps.find((s) => s.name === "promote_members")!;
const DIGEST = `ghcr.io/ocd/test@sha256:${"a".repeat(64)}`;

/** Minimal AppRow stand-in for the pure selection tests. */
function row(id: number, name: string, extra: Partial<AppRow> = {}): AppRow {
  return { id, name, target: "", target_of: null, ...extra } as AppRow;
}

function prodRow(id: number, name: string, extra: Partial<AppRow> = {}): AppRow {
  return row(id, name, extra);
}

describe("planPromotions (member/sibling selection)", () => {
  test("promotes a production member whose sibling has a deployed commit", () => {
    const prod = prodRow(1, "s-web");
    const sib = row(2, "s-web-staging", { target: "staging", target_of: 1 });
    const plan = planPromotions([prod, sib], (id) => (id === 1 ? sib : null), () => ({ image: DIGEST, commit: "abc123" }));
    expect(plan.promotions).toEqual([
      { appId: 1, appName: "s-web", sourceAppId: 2, sourceAppName: "s-web-staging", image: DIGEST, commit: "abc123" },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test("skips staging/dev rows themselves (they are the sources, not destinations)", () => {
    const sib = row(2, "s-web-staging", { target: "staging", target_of: 1 });
    const dev = row(3, "s-web-dev", { target: "dev", target_of: 1 });
    const plan = planPromotions([sib, dev], () => null, () => ({ image: DIGEST, commit: "abc123" }));
    // Not promotable AND not reported as skipped — they aren't candidates at all.
    expect(plan.promotions).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  test("skips a member with no staging sibling", () => {
    const plan = planPromotions([prodRow(1, "s-web")], () => null, () => ({ image: DIGEST, commit: "abc123" }));
    expect(plan.promotions).toEqual([]);
    expect(plan.skipped).toEqual([{ appName: "s-web", reason: "no staging sibling" }]);
  });

  test("skips a member whose sibling has never deployed successfully", () => {
    const sib = row(2, "s-web-staging", { target: "staging", target_of: 1 });
    const plan = planPromotions([prodRow(1, "s-web")], () => sib, () => null);
    expect(plan.promotions).toEqual([]);
    expect(plan.skipped).toEqual([
      { appName: "s-web", reason: "s-web-staging has no successful deployment" },
    ]);
  });

  test("mixed stack: promotes only the ready members, reports the rest", () => {
    const a = prodRow(1, "s-api");
    const aSib = row(2, "s-api-staging", { target: "staging", target_of: 1 });
    const b = prodRow(3, "s-web");
    const bSib = row(4, "s-web-staging", { target: "staging", target_of: 3 });
    const c = prodRow(5, "s-worker"); // no sibling
    const siblings = new Map<number, AppRow>([[1, aSib], [3, bSib]]);
    const plan = planPromotions(
      [a, aSib, b, bSib, c],
      (id) => siblings.get(id) ?? null,
      (id) => (id === 2 ? { image: DIGEST, commit: "sha-a" } : null),
    );
    expect(plan.promotions.map((p) => p.appName)).toEqual(["s-api"]);
    expect(plan.skipped).toEqual([
      { appName: "s-web", reason: "s-web-staging has no successful deployment" },
      { appName: "s-worker", reason: "no staging sibling" },
    ]);
  });
});

describe("orderPromotions (dependency levels)", () => {
  const promo = (id: number, name: string): Promotion => ({
    appId: id,
    appName: name,
    sourceAppId: id + 100,
    sourceAppName: `${name}-staging`,
    image: DIGEST,
    commit: "abc",
  });

  test("derives the member key by stripping the stack prefix", () => {
    expect(memberKeyOf("s", "s-web")).toBe("web");
    // Renamed out of the namespace: the whole name stands in as the key.
    expect(memberKeyOf("s", "elsewhere")).toBe("elsewhere");
  });

  test("splits a dependency chain into one level per link, in order", () => {
    const needs = new Map([["web", ["api"]], ["api", ["db"]], ["db", []]]);
    const levels = orderPromotions(
      [promo(1, "s-web"), promo(2, "s-api"), promo(3, "s-db")],
      "s",
      (p) => needs.get(memberKeyOf("s", p.appName))!,
    );
    expect(levels.map((l) => l.map((p) => p.appName))).toEqual([["s-db"], ["s-api"], ["s-web"]]);
  });

  test("independent members share one level", () => {
    const levels = orderPromotions(
      [promo(1, "s-web"), promo(2, "s-worker"), promo(3, "s-db")],
      "s",
      (p) => (p.appName === "s-db" ? [] : ["db"]),
    );
    expect(levels.map((l) => l.map((p) => p.appName))).toEqual([["s-db"], ["s-web", "s-worker"]]);
  });

  test("members with no persisted needs degrade to one concurrent batch", () => {
    // Everything deployed before migration 84 — no edges anywhere.
    const promotions = [promo(1, "s-web"), promo(2, "s-api")];
    expect(orderPromotions(promotions, "s", () => [])).toEqual([promotions]);
  });

  test("ignores needs naming members that are not being promoted", () => {
    // `web` needs `api`, but `api` was skipped (no deployed sibling), so it is
    // not a node here and must not stall or drop `web`.
    const levels = orderPromotions([promo(1, "s-web")], "s", () => ["api"]);
    expect(levels).toEqual([[promo(1, "s-web")]]);
  });

  test("throws on a cycle so the caller can fall back", () => {
    expect(() =>
      orderPromotions(
        [promo(1, "s-a"), promo(2, "s-b")],
        "s",
        (p) => (p.appName === "s-a" ? ["b"] : ["a"]),
      ),
    ).toThrow(/cycle/i);
  });
});

// --- Integration against a real temp-dir DB --------------------------------

function seedApp(name: string, envId: number): AppRow {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    environment_id: envId,
  });
}

/** A stack with `web` (staging sibling deployed), `api` (sibling never
 *  deployed) and `worker` (no sibling at all). */
function seedStack() {
  const suffix = randomSuffix();
  const env = db.insertEnvironment(`env-${suffix}`, "");
  const stack = db.insertStack({ name: `s-${suffix}`, environment_id: env.id });

  const web = seedApp(`s-${suffix}-web`, env.id);
  const webSib = seedApp(`s-${suffix}-web-staging`, env.id);
  db.setAppTarget(webSib.id, web.id, "staging");
  db.insertDeployment({ app_id: webSib.id, image_tag: DIGEST, image_digest: DIGEST, git_commit: "deadbeef", source: "release" });

  const api = seedApp(`s-${suffix}-api`, env.id);
  const apiSib = seedApp(`s-${suffix}-api-staging`, env.id);
  db.setAppTarget(apiSib.id, api.id, "staging");

  const worker = seedApp(`s-${suffix}-worker`, env.id);

  for (const a of [web, webSib, api, apiSib, worker]) db.setAppStack(a.id, stack.id);
  return { stack, web, webSib, api, apiSib, worker };
}

describe("promote_stack plan step", () => {
  test("selects only members with a deployed staging sibling", async () => {
    const { stack, web, webSib } = seedStack();
    const out = (await planStep.run(makeCtx({ stackId: stack.id }), {})) as any;
    expect(out.promotions).toHaveLength(1);
    expect(out.promotions[0]).toMatchObject({
      appId: web.id,
      sourceAppId: webSib.id,
      commit: "deadbeef",
    });
    expect(out.skipped.map((s: any) => s.appName).sort()).toEqual(
      [`${stack.name}-api`, `${stack.name}-worker`].sort(),
    );
    expect(out.levels).toHaveLength(1);
  });

  test("throws when there is nothing to promote", async () => {
    const suffix = randomSuffix();
    const env = db.insertEnvironment(`env-${suffix}`, "");
    const stack = db.insertStack({ name: `s-${suffix}`, environment_id: env.id });
    const solo = seedApp(`s-${suffix}-web`, env.id);
    db.setAppStack(solo.id, stack.id);
    await expect(planStep.run(makeCtx({ stackId: stack.id }), {})).rejects.toThrow(/nothing to promote/i);
  });

  test("throws for an unknown stack", async () => {
    await expect(planStep.run(makeCtx({ stackId: 999999 }), {})).rejects.toThrow(/not found/i);
  });
});

describe("promote_stack promote_members step", () => {
  test("enqueues one `promote` child per promotable member", async () => {
    const { stack, web, webSib } = seedStack();
    const parent = enqueueOperation({
      kind: "promote_stack",
      resourceKeys: [`stack:${stack.id}`],
      input: { stackId: stack.id },
      trigger: "test",
    });
    const ctx = makeCtx({ stackId: stack.id, userId: "u1" });
    ctx.opId = parent.id;

    const planOut = (await planStep.run(ctx, {})) as any;
    // awaitChildren resolves as soon as every targeted child is terminal; mark
    // them done from the side, standing in for the engine.
    const poll = setInterval(() => {
      for (const c of listChildOperations(parent.id)) {
        if (c.status !== "done") markOperationFinished(c.id, "done");
      }
    }, 20);
    try {
      await promoteMembersStep.run(ctx, { plan: planOut });
    } finally {
      clearInterval(poll);
    }

    const children = listChildOperations(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe("promote");
    expect(JSON.parse(children[0].input_json)).toEqual({
      appId: web.id,
      sourceAppId: webSib.id,
      userId: "u1",
    });
  });

  /** A stack of `db`, `api` (needs db) and `web` (needs api), every member
   *  promotable. `needs` are persisted as deploy_stack now records them. */
  function seedChainStack(withNeeds: boolean) {
    const suffix = randomSuffix();
    const env = db.insertEnvironment(`env-${suffix}`, "");
    const stackName = `s-${suffix}`;
    const stack = db.insertStack({ name: stackName, environment_id: env.id });
    const needs: Record<string, string[]> = { db: [], api: ["db"], web: ["api"] };
    const ids: Record<string, number> = {};
    for (const key of ["db", "api", "web"]) {
      const app = seedApp(`${stackName}-${key}`, env.id);
      const sib = seedApp(`${stackName}-${key}-staging`, env.id);
      db.setAppTarget(sib.id, app.id, "staging");
      db.insertDeployment({ app_id: sib.id, image_tag: DIGEST, image_digest: DIGEST, git_commit: `sha-${key}`, source: "release" });
      db.setAppStack(app.id, stack.id); // siblings deliberately carry no stack_id
      if (withNeeds) db.setAppStackNeeds(app.id, needs[key]);
      ids[key] = app.id;
    }
    return { stack, ids };
  }

  /** Run promote_members while marking at most ONE pending child done per tick,
   *  recording any moment where more than one child was in flight. */
  async function runWithSequentialWorker(ctx: OpContext<Input>, parentId: number) {
    const maxInFlight = { value: 0 };
    const order: number[] = [];
    const planOut = (await planStep.run(ctx, {})) as any;
    const poll = setInterval(() => {
      const children = listChildOperations(parentId);
      const pending = children.filter((c) => c.status !== "done");
      maxInFlight.value = Math.max(maxInFlight.value, pending.length);
      if (pending.length > 0) {
        order.push(JSON.parse(pending[0].input_json).appId);
        markOperationFinished(pending[0].id, "done");
      }
    }, 20);
    try {
      await promoteMembersStep.run(ctx, { plan: planOut });
    } finally {
      clearInterval(poll);
    }
    return { maxInFlight: maxInFlight.value, order };
  }

  test("promotes a dependency chain one level at a time, in order", async () => {
    const { stack, ids } = seedChainStack(true);
    const parent = enqueueOperation({
      kind: "promote_stack",
      resourceKeys: [`stack:${stack.id}`],
      input: { stackId: stack.id },
      trigger: "test",
    });
    const ctx = makeCtx({ stackId: stack.id });
    ctx.opId = parent.id;

    const { maxInFlight, order } = await runWithSequentialWorker(ctx, parent.id);
    // One child per level: db, then api, then web — never two at once.
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([ids.db, ids.api, ids.web]);
    expect(listChildOperations(parent.id)).toHaveLength(3);
  }, 30000);

  test("members with no persisted needs still promote (single concurrent batch)", async () => {
    const { stack, ids } = seedChainStack(false); // pre-migration-84 members
    const parent = enqueueOperation({
      kind: "promote_stack",
      resourceKeys: [`stack:${stack.id}`],
      input: { stackId: stack.id },
      trigger: "test",
    });
    const ctx = makeCtx({ stackId: stack.id });
    ctx.opId = parent.id;

    const { maxInFlight, order } = await runWithSequentialWorker(ctx, parent.id);
    // All three enqueued together, as before the column existed.
    expect(maxInFlight).toBe(3);
    expect(order.sort()).toEqual([ids.db, ids.api, ids.web].sort());
  }, 30000);
});
