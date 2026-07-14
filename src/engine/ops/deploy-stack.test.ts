import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  markOperationFinished,
} from "../../shared/db/operations.ts";
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
const deployAppsStep = deployStackOp.steps.find((s) => s.name === "deploy_apps")!;

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

// Simulate the reported bug: member A (postgres) deploys & is left RUNNING, then
// member B (web) fails mid-`deploy_apps`. Because a *failed* forward step isn't
// replayed as compensable, `deploy_apps`' own compensator never runs — so the
// authoritative member teardown lives in `plan`'s compensator, which always
// runs. These tests assert the succeeded member A is reaped either way.
describe("deploy_stack compensation reaps already-deployed members", () => {
  // Seed the post-failure state: A deployed new & tagged, its `deploy` child
  // 'done'; B's `deploy` child self-compensated with no surviving app row. The
  // parent op is a real row so child `parent_id` FKs resolve.
  function seedPartialFailure() {
    const name = `s-${randomSuffix()}`;
    const input = req(name, [app("postgres"), app("web", ["postgres"])]);
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;
    return { name, ctx, opId: parent.id };
  }

  async function driveWithSimulatedDestroys(opId: number, fn: () => Promise<void>) {
    // The compensator enqueues destroy_app/destroy_service children then awaits
    // them; there is no engine in this unit test, so stand in for it: mark each
    // destroy 'done' and actually remove the row (what the destroy op would do),
    // so a following env delete isn't blocked by an FK.
    const poll = setInterval(() => {
      for (const c of listChildOperations(opId)) {
        if (c.status === "done") continue;
        if (c.kind === "destroy_app") {
          markOperationFinished(c.id, "done");
          try { db.deleteApp(JSON.parse(c.input_json).appId); } catch { /* already gone */ }
        } else if (c.kind === "destroy_service") {
          markOperationFinished(c.id, "done");
          try { db.deleteService(JSON.parse(c.input_json).serviceId); } catch { /* already gone */ }
        }
      }
    }, 20);
    try { await fn(); } finally { clearInterval(poll); }
  }

  test("plan.compensate destroys member A when B fails inside deploy_apps", async () => {
    const { name, ctx, opId } = seedPartialFailure();
    const planOut = (await planStep.run(ctx, {})) as {
      stackId: number; environmentId: number; createdStack: boolean;
    };

    const aName = `${name}-postgres`;
    const appA = db.insertApp({
      name: aName, domain: `${aName}.example.com`, git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}",
      environment_id: planOut.environmentId,
    });
    db.setAppStack(appA.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${aName}`],
      input: { app_name: aName, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:postgres`,
    });
    const bDeploy = enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${name}-web`],
      input: { app_name: `${name}-web`, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:web`,
    });
    markOperationFinished(bDeploy.id, "compensated");

    await driveWithSimulatedDestroys(opId, () => planStep.compensate!(ctx, planOut, {}));

    // Member A's already-running app is torn down ...
    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(1);
    expect(JSON.parse(destroys[0].input_json).appId).toBe(appA.id);
    // ... and no stack row / self-created env is left behind.
    expect(db.getStackByName(name)).toBeNull();
    expect(db.getEnvironment(planOut.environmentId)).toBeNull();
  });

  test("teardown is idempotent: deploy_apps.compensate + plan.compensate don't double-destroy", async () => {
    const { name, ctx, opId } = seedPartialFailure();
    const planOut = (await planStep.run(ctx, {})) as { stackId: number; environmentId: number };

    const aName = `${name}-postgres`;
    const appA = db.insertApp({
      name: aName, domain: `${aName}.example.com`, git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}",
      environment_id: planOut.environmentId,
    });
    db.setAppStack(appA.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${aName}`],
      input: { app_name: aName, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:postgres`,
    });

    // First compensator (deploy_apps) enqueues + completes the destroy. Simulate
    // the engine actually removing the app row so the second pass probes it gone.
    const poll = setInterval(() => {
      for (const c of listChildOperations(opId)) {
        if (c.kind === "destroy_app" && c.status !== "done") {
          markOperationFinished(c.id, "done");
          db.deleteApp(appA.id);
        }
      }
    }, 20);
    try {
      await deployAppsStep.compensate!(ctx, undefined, {});
      // plan.compensate runs next in the reverse walk — must NOT enqueue a 2nd destroy.
      await planStep.compensate!(ctx, planOut, {});
    } finally {
      clearInterval(poll);
    }

    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(1);
    expect(db.getStackByName(name)).toBeNull();
  });
});

// Rollback must reap ONLY what this deploy newly created; anything reused
// (a caller-supplied environment, a pre-existing managed service) survives.
describe("deploy_stack compensation preserves reused resources", () => {
  async function driveWithSimulatedDestroys(opId: number, fn: () => Promise<void>) {
    const poll = setInterval(() => {
      for (const c of listChildOperations(opId)) {
        if (c.status === "done") continue;
        if (c.kind === "destroy_app") {
          markOperationFinished(c.id, "done");
          try { db.deleteApp(JSON.parse(c.input_json).appId); } catch { /* gone */ }
        } else if (c.kind === "destroy_service") {
          markOperationFinished(c.id, "done");
          try { db.deleteService(JSON.parse(c.input_json).serviceId); } catch { /* gone */ }
        }
      }
    }, 20);
    try { await fn(); } finally { clearInterval(poll); }
  }

  test("reused env + reused service survive; new member + new service are torn down", async () => {
    const existingEnv = db.insertEnvironment(`shared-${randomSuffix()}`, "");
    const name = `s-${randomSuffix()}`;
    // A managed service that ALREADY exists before this stack deploy (reused).
    const reusedSvc = db.insertService({
      name: `${name}-cache`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}",
    });

    const input = {
      ...req(name, [app("postgres"), app("web", ["postgres"])], [
        { key: "cache", type: "redis" }, // reused (pre-existing)
        { key: "queue", type: "redis" }, // newly created by this run
      ]),
      environment_id: existingEnv.id,
    } as StackDeployRequest;
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;
    const opId = parent.id;

    const planOut = (await planStep.run(ctx, {})) as {
      stackId: number; environmentId: number; createdStack: boolean;
      createdEnv: boolean; reusedServiceKeys: string[];
    };
    expect(planOut.createdEnv).toBe(false);          // reused env
    expect(planOut.reusedServiceKeys).toEqual(["cache"]); // cache pre-existed, queue didn't

    // Member A (postgres) deployed new & tagged; its `deploy` child is 'done'.
    const aName = `${name}-postgres`;
    const appA = db.insertApp({
      name: aName, domain: `${aName}.example.com`, git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile", container_port: 3000, env_vars: "{}",
      environment_id: planOut.environmentId,
    });
    db.setAppStack(appA.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${aName}`],
      input: { app_name: aName, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:postgres`,
    });
    // Member B (web) FAILED its build and self-compensated.
    const bDeploy = enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${name}-web`],
      input: { app_name: `${name}-web`, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:web`,
    });
    markOperationFinished(bDeploy.id, "compensated");

    // Both services were reconciled + tagged; `queue` was newly created this run.
    db.setServiceStack(reusedSvc.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy_service", resourceKeys: [`service:create:${name}-cache`],
      input: { name: `${name}-cache` }, trigger: "stack", parentId: opId,
      idempotencyKey: `stack:${opId}:svc:cache`,
    });
    const newSvc = db.insertService({
      name: `${name}-queue`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}",
    });
    db.setServiceStack(newSvc.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy_service", resourceKeys: [`service:create:${name}-queue`],
      input: { name: `${name}-queue` }, trigger: "stack", parentId: opId,
      idempotencyKey: `stack:${opId}:svc:queue`,
    });

    await driveWithSimulatedDestroys(opId, () => planStep.compensate!(ctx, planOut, {}));

    // Newly-created member + service ARE torn down ...
    const appDestroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(appDestroys.length).toBe(1);
    expect(JSON.parse(appDestroys[0].input_json).appId).toBe(appA.id);
    const svcDestroys = listChildOperations(opId).filter((c) => c.kind === "destroy_service");
    expect(svcDestroys.length).toBe(1);
    expect(JSON.parse(svcDestroys[0].input_json).serviceId).toBe(newSvc.id);
    expect(db.getServiceByName(`${name}-queue`)).toBeNull();

    // ... while the REUSED env + REUSED service survive the rollback.
    expect(db.getEnvironment(existingEnv.id)).not.toBeNull();
    expect(db.getServiceByName(`${name}-cache`)).not.toBeNull();
    // Stack row (created this run) is gone.
    expect(db.getStackByName(name)).toBeNull();
  });

  test("reconcile_services.compensate skips a reused service", async () => {
    const name = `s-${randomSuffix()}`;
    const reusedSvc = db.insertService({
      name: `${name}-cache`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}",
    });
    const input = req(name, [app("web")], [{ key: "cache", type: "redis" }]);
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;

    const planOut = (await planStep.run(ctx, {})) as { reusedServiceKeys: string[] };
    expect(planOut.reusedServiceKeys).toEqual(["cache"]);

    const reconcileServicesStep = deployStackOp.steps.find((s) => s.name === "reconcile_services")!;
    await reconcileServicesStep.compensate!(ctx, { childIds: [] }, { plan: planOut });

    // No destroy enqueued for the reused service; it still exists.
    expect(listChildOperations(parent.id).filter((c) => c.kind === "destroy_service")).toHaveLength(0);
    expect(db.getService(reusedSvc.id)).not.toBeNull();
  });
});
