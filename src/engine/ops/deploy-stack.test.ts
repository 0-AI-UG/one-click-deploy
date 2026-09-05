import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  markOperationFinished,
} from "../../shared/db/operations.ts";
import deployStackOp, {
  stackAppAlreadyConverged,
  stackMemberEnvironmentId,
  topoLevels,
  portCapacityExceeded,
} from "./deploy-stack.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import type { OpContext } from "../types.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { resolveAppEnvVars, resolveEnvVarsForDeploy } from "../../shared/env-crypto.ts";
import { hashEnvironment } from "../revision.ts";

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
const preflightAppsStep = deployStackOp.steps.find((s) => s.name === "preflight_apps")!;
const validatePlanStep = deployStackOp.steps.find((s) => s.name === "validate_plan")!;
const reconcileRemovalsStep = deployStackOp.steps.find((s) => s.name === "reconcile_removals")!;

function app(key: string, needs?: string[], outputs?: Record<string, { template: string; secret?: boolean }>) {
  return { key, needs, outputs, app_name: key, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 3000 };
}

function req(name: string, apps: ReturnType<typeof app>[]): StackDeployRequest {
  return { name, apps } as StackDeployRequest;
}

describe("topoLevels", () => {
  test("orders independent apps into a single level (sorted)", () => {
    expect(topoLevels([app("web"), app("api")])).toEqual([["api", "web"]]);
  });

  test("splits a dependency chain into ordered levels", () => {
    const levels = topoLevels([
      app("web", ["api"]),
      app("api", ["database"]),
      app("database"),
    ]);
    expect(levels).toEqual([["database"], ["api"], ["web"]]);
  });

  test("ignores `needs` entries that name an unknown app key", () => {
    // Unknown keys are handled by manifest validation; the pure sorter treats
    // them as already satisfied.
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

describe("stack member convergence checkpoints", () => {
  test("recognizes an unchanged, fully attested immutable member", async () => {
    const digest = `ghcr.io/example/renderer@sha256:${"a".repeat(64)}`;
    const server = db.insertServer({
      name: `checkpoint-server-${randomSuffix()}`,
      provider_id: `checkpoint-provider-${randomSuffix()}`,
      ipv4: "10.0.0.20", ipv6: "", type: "cx22", location: "fsn1", status: "ready",
    });
    const insertedApp = db.insertApp({
      name: `checkpoint-${randomSuffix()}`,
      domain: "",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: JSON.stringify({ env: {}, outputs: {} }),
    });
    db.updateAppStatus(insertedApp.id, "running");
    db.updateAppArtifactAndHealth(insertedApp.id, {
      imageRef: digest,
      healthMode: "container",
      healthCommand: "",
      healthFile: "",
      healthMaxAgeSeconds: 0,
    });
    const appRow = db.getApp(insertedApp.id)!;
    const replica = db.insertReplica({
      app_id: appRow.id,
      server_id: server.id,
      host_port: 10000,
      container_name: appRow.name,
      status: "running",
    });
    const envHash = hashEnvironment(await resolveAppEnvVars(appRow));
    db.insertDeployment({
      app_id: appRow.id,
      image_tag: digest,
      image_digest: digest,
      env_hash: envHash,
      git_commit: "artifact",
      config_revision: appRow.config_revision,
    });
    db.recordReplicaAttestation(replica.id, {
      imageDigest: `sha256:${"b".repeat(64)}`,
      desiredImageDigest: digest,
      envHash,
      configRevision: appRow.config_revision,
    });

    expect(await stackAppAlreadyConverged(appRow, `artifact:${digest}`)).toEqual({
      converged: true,
      reason: "source, config, environment, replicas, and links match",
    });
  });
});

describe("deploy_stack plan step", () => {
  test("runs pure manifest validation before remote preflight and state mutation", async () => {
    expect(deployStackOp.steps.indexOf(validatePlanStep)).toBeLessThan(
      deployStackOp.steps.indexOf(preflightAppsStep),
    );
    const name = `s-${randomSuffix()}`;
    const input = {
      ...req(name, [{ ...app("web"), internal_protocol: "smtp" } as any]),
    } as StackDeployRequest;
    await expect(validatePlanStep.run(makeCtx(input), {})).rejects.toThrow(/internal protocol/i);
    expect(db.getStackByName(name)).toBeNull();
    expect(db.getEnvironments().some((environment) => environment.name.startsWith(name))).toBe(false);
  });

  test("rejects an invalid stack name", async () => {
    const ctx = makeCtx(req("Bad Name", [app("web")]));
    await expect(planStep.run(ctx, {})).rejects.toThrow();
  });

  test("rejects a `needs` referencing an unknown key", async () => {
    const ctx = makeCtx(req(`s-${randomSuffix()}`, [app("web", ["nope"])]));
    await expect(planStep.run(ctx, {})).rejects.toThrow(/unknown key/i);
  });

  test("creates a stack without an implicit environment and returns topo levels", async () => {
    const name = `s-${randomSuffix()}`;
    const ctx = makeCtx(req(name, [app("web", ["api"]), app("api")]));
    const out = (await planStep.run(ctx, {})) as {
      stackId: number; environmentId: number | null; levels: string[][];
    };

    expect(out.levels).toEqual([["api"], ["web"]]);
    const stack = db.getStackByName(name);
    expect(stack).not.toBeNull();
    expect(stack!.environment_id).toBe(out.environmentId);
    expect(out.environmentId).toBeNull();
  });

  test("is idempotent on resume: a second plan reuses the existing stack", async () => {
    const name = `s-${randomSuffix()}`;
    const ctx = makeCtx(req(name, [app("web")]));
    const first = (await planStep.run(ctx, {})) as { stackId: number };

    const second = (await planStep.run(ctx, {})) as { stackId: number };

    expect(second.stackId).toBe(first.stackId);
  });

  test("reuses a caller-supplied environment instead of creating a fresh one", async () => {
    const existing = db.insertEnvironment(`shared-${randomSuffix()}`, "");
    const name = `s-${randomSuffix()}`;
    const input = { ...req(name, [app("web")]), environment_id: existing.id };
    const ctx = makeCtx(input);
    const out = (await planStep.run(ctx, {})) as {
      environmentId: number;
    };
    expect(out.environmentId).toBe(existing.id);


    expect(db.getStackByName(name)!.environment_id).toBe(existing.id);
  });

  test("rejects a reuse of a non-existent environment", async () => {
    const input = { ...req(`s-${randomSuffix()}`, [app("web")]), environment_id: 999999 };
    await expect(planStep.run(makeCtx(input), {})).rejects.toThrow(/not found/i);
  });

  test("compensation retains stack environments as resumable desired state", async () => {
    const existing = db.insertEnvironment(`shared-${randomSuffix()}`, "");
    // Reuse: env must survive rollback.
    const reuseInput = { ...req(`s-${randomSuffix()}`, [app("web")]), environment_id: existing.id };
    const reuseOut = (await planStep.run(makeCtx(reuseInput), {})) as any;
    await planStep.compensate!(makeCtx(reuseInput), reuseOut, {});
    expect(db.getEnvironment(existing.id)).not.toBeNull();
    expect(db.getStackByName(reuseInput.name)?.status).toBe("failed");

    // Auto-created desired state is also retained for the next reconcile.
    const freshInput = req(`s-${randomSuffix()}`, [app("web")]);
    const freshOut = (await planStep.run(makeCtx(freshInput), {})) as any;
    await planStep.compensate!(makeCtx(freshInput), freshOut, {});
    expect(freshOut.environmentId).toBeNull();
    expect(db.getStackByName(freshInput.name)?.status).toBe("failed");
  });
});

// Simulate the reported bug: member A (postgres) deploys & is left RUNNING, then
// member B (web) fails mid-`deploy_apps`. Because a *failed* forward step isn't
// replayed as compensable, `deploy_apps`' own compensator never runs — so the
// authoritative member teardown lives in `plan`'s compensator, which always
// runs. These tests assert the succeeded member A is reaped either way.
describe("deploy_stack compensation retains already-deployed members", () => {
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
    // The compensator awaits destroy children; there is no engine in this
    // unit test, so stand in for it and apply the app-row deletion.
    const poll = setInterval(() => {
      for (const c of listChildOperations(opId)) {
        if (c.status === "done") continue;
        if (c.kind === "destroy_app") {
          markOperationFinished(c.id, "done");
          try { db.deleteApp(JSON.parse(c.input_json).appId); } catch { /* already gone */ }
        }
      }
    }, 20);
    try { await fn(); } finally { clearInterval(poll); }
  }

  test("plan.compensate retains member A when B fails inside deploy_apps", async () => {
    const { name, ctx, opId } = seedPartialFailure();
    const planOut = (await planStep.run(ctx, {})) as {
      stackId: number; environmentId: number;
    };

    const aName = `${name}-postgres`;
    const appA = db.insertApp({
      name: aName, domain: `${aName}.example.com`, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      environment_id: planOut.environmentId,
      container_port: 3000, env_vars: JSON.stringify({ env: {}, outputs: {} }),
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

    // Member A is a durable checkpoint; no destructive child is enqueued.
    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(0);
    expect(db.getApp(appA.id)).not.toBeNull();
    expect(db.getStackByName(name)?.status).toBe("failed");
    expect(planOut.environmentId).toBeNull();
  });

  test("repeated compensation preserves the same successful checkpoint", async () => {
    const { name, ctx, opId } = seedPartialFailure();
    const planOut = (await planStep.run(ctx, {})) as { stackId: number; environmentId: number };

    const aName = `${name}-postgres`;
    const appA = db.insertApp({
      name: aName, domain: `${aName}.example.com`, image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      environment_id: planOut.environmentId,
      container_port: 3000, env_vars: JSON.stringify({ env: {}, outputs: {} }),
    });
    db.setAppStack(appA.id, planOut.stackId);
    enqueueOperation({
      kind: "deploy", resourceKeys: [`app:create:${aName}`],
      input: { app_name: aName, environment_id: planOut.environmentId },
      trigger: "stack", parentId: opId, idempotencyKey: `stack:${opId}:app:postgres`,
    });

    await planStep.compensate!(ctx, planOut, {});
    await planStep.compensate!(ctx, planOut, {});

    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(0);
    expect(db.getApp(appA.id)).not.toBeNull();
    expect(db.getStackByName(name)?.status).toBe("failed");
  });
});

describe("deploy_stack membership reconciliation", () => {
  test("a full reconcile removes members no longer present in the manifest", async () => {
    const name = `membership-${randomSuffix()}`;
    const input = req(name, [app("web")]);
    const parent = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: [`stack:${name}`],
      input,
      trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;
    const planOut = await planStep.run(ctx, {}) as { stackId: number; environmentId: number };
    const stale = db.insertApp({
      name: `${name}-database`,
      domain: "",
      image_ref: app("database").image_ref,
      container_port: 5432,
      environment_id: planOut.environmentId,
      env_vars: JSON.stringify({ env: {}, outputs: {} }),
    });
    db.setAppStack(stale.id, planOut.stackId);

    const poll = setInterval(() => {
      for (const child of listChildOperations(parent.id)) {
        if (child.kind !== "destroy_app" || child.status === "done") continue;
        const { appId } = JSON.parse(child.input_json) as { appId: number };
        db.deleteApp(appId);
        markOperationFinished(child.id, "done");
      }
    }, 10);
    try {
      const result = await reconcileRemovalsStep.run(ctx, { plan: planOut });
      expect(result).toEqual({ removed: 1 });
    } finally {
      clearInterval(poll);
    }

    expect(db.getApp(stale.id)).toBeNull();
    expect(listChildOperations(parent.id).filter((child) => child.kind === "destroy_app")).toHaveLength(1);
  });

  test("a partial reconcile retains members omitted from the request", async () => {
    const name = `membership-${randomSuffix()}`;
    const input = { ...req(name, [app("web")]), partial: true } as StackDeployRequest;
    const planOut = await planStep.run(makeCtx(input), {}) as { stackId: number; environmentId: number };
    const retained = db.insertApp({
      name: `${name}-database`,
      domain: "",
      image_ref: app("database").image_ref,
      container_port: 5432,
      environment_id: planOut.environmentId,
      env_vars: JSON.stringify({ env: {}, outputs: {} }),
    });
    db.setAppStack(retained.id, planOut.stackId);

    expect(await reconcileRemovalsStep.run(makeCtx(input), { plan: planOut })).toEqual({ removed: 0 });
    expect(db.getApp(retained.id)).not.toBeNull();
  });
});


describe("explicit stack runtime environment", () => {
  test("infers ordering from output references", () => {
    expect(topoLevels([
      { ...app("web"), env: { DATABASE_URL: { from: "apps.database.outputs.URL" } } },
      app("database"),
    ])).toEqual([["database"], ["web"]]);
  });
  test("rejects a missing environment reference before creating state", async () => {
    const input = req(`s-${randomSuffix()}`, [app("web")]);
    input.apps[0].env = { TOKEN: { from: "environment.TOKEN" } };
    await expect(validatePlanStep.run(makeCtx(input), {})).rejects.toThrow();
    expect(db.getStackByName(input.name)).toBeNull();
  });
  test("validates output references against desired members before creation", async () => {
    const input = req(`s-${randomSuffix()}`, [app("web"), app("database", undefined, {
      URL: { template: "postgres://{app.host}:{app.port}" },
    })]);
    input.apps[0].env = { DATABASE_URL: { from: "apps.database.outputs.URL" } };
    const result = await validatePlanStep.run(makeCtx(input), {}) as { levels: string[][] };
    expect(result.levels).toEqual([["database"], ["web"]]);
    expect(db.getStackByName(input.name)).toBeNull();
  });
  test("does not change stored values and clears omitted environment selectors", async () => {
    const environment = db.insertEnvironment(`existing-${randomSuffix()}`, "{}");
    const input = { ...req(`s-${randomSuffix()}`, [app("web")]), environment_id: environment.id, staging_environment_id: environment.id };
    await planStep.run(makeCtx(input), {});
    expect(db.getEnvironment(environment.id)!.env_vars).toBe("{}");
    await planStep.run(makeCtx(req(input.name, [app("web")])), {});
    expect(db.getStackByName(input.name)!.environment_id).toBeNull();
    expect(db.getStackByName(input.name)!.staging_environment_id).toBeNull();
  });
});

describe("stack member environment selectors", () => {
  test("omission inherits the stack environment", () => {
    expect(stackMemberEnvironmentId(app("web"), 10)).toBe(10);
  });
  test("an explicit child environment selects its existing values", () => {
    const child = db.insertEnvironment(`child-${randomSuffix()}`, "{}");
    expect(stackMemberEnvironmentId({ ...app("web"), environment: child.name }, 10)).toBe(child.id);
  });
  test("an explicit null detaches a child from the stack environment", () => {
    expect(stackMemberEnvironmentId({ ...app("web"), environment: null }, 10)).toBeNull();
  });
});

test("stack preflight resolves inherited and overridden values and rejects detached references", async () => {
  const { serializeEnvVars } = await import("../../shared/env-crypto.ts");
  const shared = db.insertEnvironment(`shared-${randomSuffix()}`, serializeEnvVars([
    { key: "SHARED", value: "shared", secret: false, updated_at: "now" },
  ]));
  const child = db.insertEnvironment(`child-${randomSuffix()}`, serializeEnvVars([
    { key: "CHILD", value: "child", secret: false, updated_at: "now" },
  ]));
  const input: StackDeployRequest = { name: `selectors-${randomSuffix()}`, environment_id: shared.id, apps: [
    { ...app("inherited"), env: { VALUE: { from: "environment.SHARED" } } },
    { ...app("overridden"), environment: child.name, env: { VALUE: { from: "environment.CHILD" } } },
  ] };
  await validatePlanStep.run(makeCtx(input), {});
  input.apps[1].environment = null;
  await expect(validatePlanStep.run(makeCtx(input), {})).rejects.toThrow(/none is selected/);
  expect(db.getStackByName(input.name)).toBeNull();
});
