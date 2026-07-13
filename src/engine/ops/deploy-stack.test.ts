import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import deployStackOp, { topoLevels, portCapacityExceeded } from "./deploy-stack.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import type { OpContext } from "../types.ts";

// Minimal OpContext for exercising a step's run() directly against a real
// temp-dir DB (mirrors src/engine/ops/deploy.test.ts's makeCtx).
function makeCtx(input: StackDeployRequest): OpContext<StackDeployRequest> {
  return {
    opId: 1,
    kind: "deploy_stack",
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

const planStep = deployStackOp.steps.find((s) => s.name === "plan")!;

function app(key: string, needs?: string[]) {
  return { key, needs, app_name: key, git_repo: "https://github.com/x/y", container_port: 3000 };
}

function req(name: string, apps: ReturnType<typeof app>[], services: Array<{ key: string; type: string }> = []): StackDeployRequest {
  return { name, apps, services } as unknown as StackDeployRequest;
}

describe("topoLevels", () => {
  test("orders independent apps into a single level (sorted)", () => {
    expect(topoLevels([app("web"), app("api")])).toEqual([["api", "web"]]);
  });

  test("splits a dependency chain into ordered levels", () => {
    // web -> api -> (nothing). db is a service key, ignored for ordering.
    const levels = topoLevels([app("web", ["api"]), app("api", ["db"])]);
    expect(levels).toEqual([["api"], ["web"]]);
  });

  test("ignores `needs` entries that name a non-app (service) key", () => {
    // Only `cache`/`db` (not in the app set) — treated as satisfied, so both
    // apps land in the first level.
    const levels = topoLevels([app("api", ["db"]), app("worker", ["cache"])]);
    expect(levels).toEqual([["api", "worker"]]);
  });

  test("groups a diamond into three levels", () => {
    const levels = topoLevels([
      app("frontend", ["a", "b"]),
      app("a", ["base"]),
      app("b", ["base"]),
      app("base"),
    ]);
    expect(levels).toEqual([["base"], ["a", "b"], ["frontend"]]);
  });

  test("throws on a dependency cycle", () => {
    expect(() => topoLevels([app("a", ["b"]), app("b", ["a"])])).toThrow(/cycle/i);
  });
});

describe("portCapacityExceeded", () => {
  test("false when the new apps fit under the cap", () => {
    expect(portCapacityExceeded(198, 2, 200)).toBe(false);
  });
  test("true when the new apps exceed the cap", () => {
    expect(portCapacityExceeded(199, 2, 200)).toBe(true);
  });
  test("boundary: exactly at the cap is allowed", () => {
    expect(portCapacityExceeded(150, 50, 200)).toBe(false);
  });
});

describe("deploy_stack plan step", () => {
  test("rejects an invalid stack name", async () => {
    const ctx = makeCtx(req("Bad Name", [app("web")]));
    await expect(planStep.run(ctx, {})).rejects.toThrow();
  });

  test("rejects a `needs` referencing an unknown key", async () => {
    const ctx = makeCtx(req(`s-${randomSuffix()}`, [app("web", ["nope"])]));
    await expect(planStep.run(ctx, {})).rejects.toThrow(/unknown key/i);
  });

  test("creates the stack + its environment and returns topo levels", async () => {
    const name = `s-${randomSuffix()}`;
    const ctx = makeCtx(req(name, [app("web", ["api"]), app("api")]));
    const out = (await planStep.run(ctx, {})) as {
      stackId: number; environmentId: number; levels: string[][]; createdStack: boolean;
    };
    expect(out.createdStack).toBe(true);
    expect(out.levels).toEqual([["api"], ["web"]]);
    const stack = db.getStackByName(name);
    expect(stack).not.toBeNull();
    expect(stack!.environment_id).toBe(out.environmentId);
    expect(db.getEnvironment(out.environmentId)).not.toBeNull();
  });

  test("is idempotent on resume: a second plan reuses the existing stack", async () => {
    const name = `s-${randomSuffix()}`;
    const ctx = makeCtx(req(name, [app("web")]));
    const first = (await planStep.run(ctx, {})) as { stackId: number; createdStack: boolean };
    expect(first.createdStack).toBe(true);
    const second = (await planStep.run(ctx, {})) as { stackId: number; createdStack: boolean };
    expect(second.createdStack).toBe(false);
    expect(second.stackId).toBe(first.stackId);
  });

  test("reuses a caller-supplied environment instead of creating a fresh one", async () => {
    const existing = db.insertEnvironment(`shared-${randomSuffix()}`, "");
    const name = `s-${randomSuffix()}`;
    const input = { ...req(name, [app("web")]), environment_id: existing.id };
    const ctx = makeCtx(input);
    const out = (await planStep.run(ctx, {})) as {
      environmentId: number; createdStack: boolean; createdEnv: boolean;
    };
    expect(out.environmentId).toBe(existing.id);
    expect(out.createdStack).toBe(true);
    expect(out.createdEnv).toBe(false);
    expect(db.getStackByName(name)!.environment_id).toBe(existing.id);
  });

  test("writes the merged stack env_vars into the shared environment", async () => {
    const name = `s-${randomSuffix()}`;
    const input = {
      ...req(name, [app("web")]),
      env_vars: [{ key: "SHARED", value: "v1", secret: false }],
    } as StackDeployRequest;
    const out = (await planStep.run(makeCtx(input), {})) as { environmentId: number };
    const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
    const flat = await resolveEnvVarsForDeploy(db.getEnvironment(out.environmentId)!.env_vars);
    expect(flat.SHARED).toBe("v1");
  });

  test("stack env_vars overlay a reused environment without dropping its other keys", async () => {
    const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
    const existing = db.insertEnvironment(
      `shared-${randomSuffix()}`,
      serializeEnvVars([{ key: "KEEP", value: "orig", secret: false, updated_at: "t" }]),
    );
    const name = `s-${randomSuffix()}`;
    const input = {
      ...req(name, [app("web")]),
      environment_id: existing.id,
      env_vars: [{ key: "ADDED", value: "new", secret: false }],
    } as StackDeployRequest;
    await planStep.run(makeCtx(input), {});
    const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
    const flat = await resolveEnvVarsForDeploy(db.getEnvironment(existing.id)!.env_vars);
    expect(flat).toEqual({ KEEP: "orig", ADDED: "new" });
  });

  test("rejects a reuse of a non-existent environment", async () => {
    const input = { ...req(`s-${randomSuffix()}`, [app("web")]), environment_id: 999999 };
    await expect(planStep.run(makeCtx(input), {})).rejects.toThrow(/not found/i);
  });

  test("compensation preserves a reused environment but destroys a self-created one", async () => {
    const existing = db.insertEnvironment(`shared-${randomSuffix()}`, "");
    // Reuse: env must survive rollback.
    const reuseInput = { ...req(`s-${randomSuffix()}`, [app("web")]), environment_id: existing.id };
    const reuseOut = (await planStep.run(makeCtx(reuseInput), {})) as any;
    await planStep.compensate!(makeCtx(reuseInput), reuseOut, {});
    expect(db.getEnvironment(existing.id)).not.toBeNull();
    expect(db.getStackByName(reuseInput.name)).toBeNull();

    // Auto-created: env is torn down with the stack.
    const freshInput = req(`s-${randomSuffix()}`, [app("web")]);
    const freshOut = (await planStep.run(makeCtx(freshInput), {})) as any;
    await planStep.compensate!(makeCtx(freshInput), freshOut, {});
    expect(db.getEnvironment(freshOut.environmentId)).toBeNull();
    expect(db.getStackByName(freshInput.name)).toBeNull();
  });
});
