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
  dependencyProjectionKeys,
  leastPrivilegeProjection,
  suspiciousUnrelatedProjectionKeys,
  stackAppAlreadyConverged,
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
const reconcileServicesStep = deployStackOp.steps.find((s) => s.name === "reconcile_services")!;
const reconcileRemovalsStep = deployStackOp.steps.find((s) => s.name === "reconcile_removals")!;
const preflightAppsStep = deployStackOp.steps.find((s) => s.name === "preflight_apps")!;
const validatePlanStep = deployStackOp.steps.find((s) => s.name === "validate_plan")!;

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

describe("least-privilege stack environment projection", () => {
  test("includes declared variables and generated dependency variables", () => {
    const input = req(
      "safe",
      [app("web", ["api", "database"]), app("api")],
      [{ key: "database", type: "postgresql" }],
    );
    const web = {
      ...input.apps[0],
      declared_env_keys: ["NODE_ENV", "STRIPE_API_KEY"],
      env_projection_mode: "declared" as const,
    };
    expect(dependencyProjectionKeys(web, input)).toEqual([
      "API_URL",
      "DATABASE_URL",
      "DATABASE_HOST",
      "DATABASE_PORT",
      "DATABASE_USER",
      "DATABASE_PASSWORD",
      "DATABASE_NAME",
    ]);
    expect(leastPrivilegeProjection(web, input)).toEqual([
      "API_URL",
      "DATABASE_HOST",
      "DATABASE_NAME",
      "DATABASE_PASSWORD",
      "DATABASE_PORT",
      "DATABASE_URL",
      "DATABASE_USER",
      "NODE_ENV",
      "STRIPE_API_KEY",
    ]);
  });

  test("warn candidates contain names only and exclude declared/dependency secrets", () => {
    expect(suspiciousUnrelatedProjectionKeys(
      [
        "DATABASE_PASSWORD",
        "STRIPE_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "MONGO_URL",
        "DOCS_THEME",
        "EMAIL_TOKEN",
      ],
      ["DATABASE_PASSWORD", "DOCS_THEME"],
      null,
    )).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "EMAIL_TOKEN",
      "MONGO_URL",
      "STRIPE_API_KEY",
    ]);
    expect(suspiciousUnrelatedProjectionKeys(
      ["STRIPE_API_KEY", "EMAIL_TOKEN"],
      [],
      ["EMAIL_TOKEN"],
    )).toEqual(["EMAIL_TOKEN"]);
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
      git_repo: "",
      dockerfile_path: "",
      container_port: 3000,
      env_vars: "{}",
    });
    db.updateAppStatus(insertedApp.id, "running");
    db.updateAppArtifactAndHealth(insertedApp.id, {
      imageRef: digest,
      buildCacheRef: "",
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
      ...req(name, [{ ...app("web"), webhook_staging: true } as any]),
    } as StackDeployRequest;
    await expect(validatePlanStep.run(makeCtx(input), {})).rejects.toThrow(/webhook\.enabled/);
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
    expect(db.getEnvironment(freshOut.environmentId)).not.toBeNull();
    expect(db.getStackByName(freshInput.name)?.status).toBe("failed");
  });
});

describe("deploy_stack app preflight", () => {
  test("runs before service deployment and rejects unsafe build inputs", async () => {
    expect(deployStackOp.steps.indexOf(preflightAppsStep)).toBeLessThan(
      deployStackOp.steps.indexOf(reconcileServicesStep),
    );
    const input = {
      ...req(`pre-${randomSuffix()}`, [app("api")]),
      apps: [{ ...app("api"), dockerfile_path: "../Dockerfile" }],
    } as StackDeployRequest;
    await expect(preflightAppsStep.run(makeCtx(input), {
      plan: { stackId: 1 },
    })).rejects.toThrow(/Dockerfile path must not contain/i);
  });
});

describe("deploy_stack service adoption", () => {
  test("adopts a recovered existing service instead of enqueueing service:create again", async () => {
    const name = `adopt-${randomSuffix()}`;
    const input = req(name, [], [{ key: "db", type: "postgresql" }]);
    const service = db.insertService({
      name: `${name}-db`,
      service_type: "postgresql",
      version: "17-alpine",
      port: 5432,
      env_vars: "{}",
      credentials: JSON.stringify({
        host: `${name}-db.svc.ocd.internal`,
        port: 15432,
        username: "postgres",
        password: "secret",
        database: "ocd_db",
        connection_url: `postgresql://postgres:secret@${name}-db.svc.ocd.internal:15432/ocd_db`,
      }),
    });
    const ctx = makeCtx(input);
    const planOut = await planStep.run(ctx, {}) as any;

    const result = await reconcileServicesStep.run(ctx, { plan: planOut }) as { childIds: number[] };

    expect(result.childIds).toEqual([]);
    expect(db.getService(service.id)?.stack_id).toBe(planOut.stackId);
    expect(db.getServiceLinks(service.id)).toHaveLength(1);
    expect(db.getServiceLinks(service.id)[0].environment_id).toBe(planOut.environmentId);
    expect(
      listChildOperations(ctx.opId).filter((op) => op.kind === "deploy_service"),
    ).toHaveLength(0);
  });

  test("rejects immutable managed-service version drift instead of reporting success", async () => {
    const name = `drift-${randomSuffix()}`;
    const input = req(name, [], [{ key: "db", type: "postgresql", version: "17-pgmq" } as any]);
    db.insertService({
      name: `${name}-db`,
      service_type: "postgresql",
      version: "17-alpine",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    const ctx = makeCtx(input);
    const planOut = await planStep.run(ctx, {}) as any;

    await expect(reconcileServicesStep.run(ctx, { plan: planOut }))
      .rejects.toThrow(/immutable managed-service drift.*17-alpine.*17-pgmq.*confirmation is required/i);
  });

  test("injects explicitly-owned staging counterparts only into the staging environment", async () => {
    const name = `staging-svc-${randomSuffix()}`;
    const input = req(
      name,
      [{ ...app("web"), webhook_enabled: true, webhook_staging: true } as any],
      [{ key: "db", type: "postgresql" }],
    );
    const ctx = makeCtx(input);
    const planOut = await planStep.run(ctx, {}) as any;
    const production = db.insertService({
      name: `${name}-db`, service_type: "postgresql", version: "17-alpine", port: 5432,
      env_vars: "{}", credentials: JSON.stringify({
        host: `${name}-db.svc.ocd.internal`, port: 15000,
        username: "prod", password: "prod-secret", database: "prod",
        connection_url: `postgresql://prod:prod-secret@${name}-db.svc.ocd.internal:15000/prod`,
      }),
    });
    const staging = db.insertService({
      name: `${name}-db-staging`, service_type: "postgresql", version: "17-alpine", port: 5432,
      env_vars: "{}", credentials: JSON.stringify({
        host: `${name}-db-staging.svc.ocd.internal`, port: 15001,
        username: "stage", password: "stage-secret", database: "stage",
        connection_url: `postgresql://stage:stage-secret@${name}-db-staging.svc.ocd.internal:15001/stage`,
      }),
      stack_id: planOut.stackId,
      target: "staging",
      target_of: production.id,
      placement_pool: "staging",
    });

    const out = await reconcileServicesStep.run(ctx, { plan: planOut }) as { childIds: number[] };
    expect(out.childIds).toEqual([]);
    expect(db.getStagingService(production.id)?.id).toBe(staging.id);
    const prodVars = await resolveEnvVarsForDeploy(db.getEnvironment(planOut.environmentId)!.env_vars);
    const stageVars = await resolveEnvVarsForDeploy(db.getEnvironment(planOut.stagingEnvironmentId)!.env_vars);
    expect(prodVars.DB_HOST).toBe(`${name}-db.svc.ocd.internal`);
    expect(stageVars.DB_HOST).toBe(`${name}-db-staging.svc.ocd.internal`);
    expect(stageVars.DB_URL).toContain("stage-secret");
    expect(db.getServiceLinks(production.id).map((link) => link.environment_id)).toEqual([planOut.environmentId]);
    expect(db.getServiceLinks(staging.id).map((link) => link.environment_id)).toEqual([planOut.stagingEnvironmentId]);
  });

  test("refuses to adopt an unowned same-name service as a staging counterpart", async () => {
    const name = `staging-conflict-${randomSuffix()}`;
    const input = req(
      name,
      [{ ...app("web"), webhook_enabled: true, webhook_staging: true } as any],
      [{ key: "cache", type: "redis" }],
    );
    const ctx = makeCtx(input);
    const planOut = await planStep.run(ctx, {}) as any;
    db.insertService({
      name: `${name}-cache`, service_type: "redis", version: "7-alpine", port: 6379,
      env_vars: "{}", credentials: "{}",
    });
    db.insertService({
      name: `${name}-cache-staging`, service_type: "redis", version: "7-alpine", port: 6379,
      env_vars: "{}", credentials: "{}",
      // Defaults to production/general: it is deliberately not adoptable.
    });
    await expect(reconcileServicesStep.run(ctx, { plan: planOut }))
      .rejects.toThrow(/identity conflict.*refusing to adopt/i);
  });

  test("grows a declared existing service volume and waits for provider confirmation", async () => {
    const name = `resize-${randomSuffix()}`;
    const input = req(name, [], [{ key: "db", type: "postgresql", volume_size: 30 } as any]);
    const server = db.insertServer({
      name: `${name}-server`, provider_id: `provider-${name}`, ipv4: "10.0.0.8", ipv6: "",
      type: "cx22", location: "fsn1", status: "ready",
    });
    const service = db.insertService({
      name: `${name}-db`, service_type: "postgresql", version: "17-alpine", port: 5432,
      env_vars: "{}", credentials: "{}",
    });
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      role: "primary",
      container_name: `${name}-db`,
      host_port: 15000,
      volume_id: "vol-resize",
      volume_mount: "/mnt/db:/var/lib/postgresql/data",
      status: "running",
    });
    const ctx = makeCtx(input);
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    ctx.opId = parent.id;
    const planOut = await planStep.run(ctx, {}) as any;
    const originalGet = hetzner.volumes.get;
    let observedSize = 10;
    hetzner.volumes.get = (async (id: string) => ({
      providerId: id, name: "db", sizeGb: observedSize, location: "fsn1", serverId: server.provider_id,
    })) as typeof hetzner.volumes.get;
    const poll = setInterval(() => {
      const resize = listChildOperations(parent.id).find((child) => child.kind === "resize_volume");
      if (resize && resize.status !== "done") {
        observedSize = 30;
        markOperationFinished(resize.id, "done");
      }
    }, 5);
    try {
      await reconcileServicesStep.run(ctx, { plan: planOut });
    } finally {
      clearInterval(poll);
      hetzner.volumes.get = originalGet;
    }
    const resize = listChildOperations(parent.id).find((child) => child.kind === "resize_volume");
    expect(resize).not.toBeUndefined();
    expect(JSON.parse(resize!.input_json)).toEqual({ volumeId: "vol-resize", sizeGb: 30 });
    expect(observedSize).toBe(30);
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

  test("plan.compensate retains member A when B fails inside deploy_apps", async () => {
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

    // Member A is a durable checkpoint; no destructive child is enqueued.
    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(0);
    expect(db.getApp(appA.id)).not.toBeNull();
    expect(db.getStackByName(name)?.status).toBe("failed");
    expect(db.getEnvironment(planOut.environmentId)).not.toBeNull();
  });

  test("repeated compensation preserves the same successful checkpoint", async () => {
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

    await planStep.compensate!(ctx, planOut, {});
    await planStep.compensate!(ctx, planOut, {});

    const destroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(destroys.length).toBe(0);
    expect(db.getApp(appA.id)).not.toBeNull();
    expect(db.getStackByName(name)?.status).toBe("failed");
  });
});

// Rollback must reap ONLY what this deploy newly created; anything reused
// (a caller-supplied environment, a pre-existing managed service) survives.
describe("deploy_stack compensation preserves reconciliation checkpoints", () => {
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

  test("reused and newly-successful resources survive for retry", async () => {
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

    // New and reused members are all retained as resume checkpoints.
    const appDestroys = listChildOperations(opId).filter((c) => c.kind === "destroy_app");
    expect(appDestroys.length).toBe(0);
    const svcDestroys = listChildOperations(opId).filter((c) => c.kind === "destroy_service");
    expect(svcDestroys.length).toBe(0);
    expect(db.getApp(appA.id)).not.toBeNull();
    expect(db.getService(newSvc.id)).not.toBeNull();

    // ... while the REUSED env + REUSED service survive the rollback.
    expect(db.getEnvironment(existingEnv.id)).not.toBeNull();
    const survivingCache = db.getServiceByName(`${name}-cache`);
    expect(survivingCache).not.toBeNull();
    expect(survivingCache!.stack_id).toBe(planOut.stackId);
    expect(db.getStackByName(name)?.status).toBe("failed");
  });

  test("first-up failure retains reused and newly-created successful services", async () => {
    const name = `s-${randomSuffix()}`;
    // A managed service that ALREADY exists (reused on this first up).
    const reusedSvc = db.insertService({
      name: `${name}-cache`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}",
    });
    const input = req(name, [app("web")], [
      { key: "cache", type: "redis" }, // reused
      { key: "queue", type: "redis" }, // newly created this run
    ]);
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;
    const opId = parent.id;

    const planOut = (await planStep.run(ctx, {})) as {
      stackId: number; createdStack: boolean; reusedServiceKeys: string[];
    };
    expect(planOut.createdStack).toBe(true);            // first up
    expect(planOut.reusedServiceKeys).toEqual(["cache"]);

    // reconcile_services tagged BOTH the reused and the newly-created service.
    db.setServiceStack(reusedSvc.id, planOut.stackId);
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

    // Both successful services survive and remain stack-owned for retry.
    expect(db.getServiceByName(`${name}-queue`)).not.toBeNull();
    const cache = db.getServiceByName(`${name}-cache`);
    expect(cache).not.toBeNull();
    expect(cache!.stack_id).toBe(planOut.stackId);
    expect(db.getStackByName(name)?.status).toBe("failed");
  });

  test("reconcile_services has no destructive compensation", async () => {
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
    expect(reconcileServicesStep.compensate).toBeUndefined();

    // No destroy enqueued for the reused service; it still exists.
    expect(listChildOperations(parent.id).filter((c) => c.kind === "destroy_service")).toHaveLength(0);
    expect(db.getService(reusedSvc.id)).not.toBeNull();
  });
});


describe("deploy_stack shared staging environment", () => {
  /** A member that opted into webhook staging via its OWN manifest. That opt-in
   *  is the only staging input a member has — there is no per-app override. */
  function stagingApp(key: string) {
    return { ...app(key), webhook_enabled: true, webhook_staging: true };
  }

  function planOf(
    name: string,
    apps: unknown[],
    opts: { staging?: number | null; envVars?: Array<{ key: string; value: string }> } = {},
  ) {
    const input = {
      ...req(name, apps as ReturnType<typeof app>[]),
      ...("staging" in opts ? { staging_environment_id: opts.staging } : {}),
      ...(opts.envVars ? { env_vars: opts.envVars } : {}),
    } as StackDeployRequest;
    return planStep.run(makeCtx(input), {});
  }

  type Out = {
    stagingEnvironmentId: number | null;
    stagingByKey: Record<string, number | null>;
    createdStagingEnv: boolean;
    environmentId: number;
  };

  test("auto-creates the staging env as a copy of the stack env when a member opts in", async () => {
    const name = `s-${randomSuffix()}`;
    const out = (await planOf(name, [stagingApp("web"), app("api")], {
      envVars: [{ key: "SHARED", value: "yes" }],
    })) as Out;

    expect(out.createdStagingEnv).toBe(true);
    expect(out.stagingEnvironmentId).not.toBeNull();
    expect(db.getStackByName(name)!.staging_environment_id).toBe(out.stagingEnvironmentId);

    const staging = db.getEnvironment(out.stagingEnvironmentId!)!;
    expect(staging.name).toBe(`${name}-stack-staging-env`);
    // Seeded from the production stack env, so members boot with real values.
    expect(staging.env_vars).toContain("SHARED");
    expect(out.stagingEnvironmentId).not.toBe(out.environmentId);
  });

  test("creates no staging env when no member opts in", async () => {
    const name = `s-${randomSuffix()}`;
    const out = (await planOf(name, [app("web"), app("api")])) as Out;
    expect(out.createdStagingEnv).toBe(false);
    expect(out.stagingEnvironmentId).toBeNull();
    expect(db.getStackByName(name)!.staging_environment_id).toBeNull();
  });

  test("reuses an explicitly named staging env instead of auto-creating one", async () => {
    const chosen = db.insertEnvironment(`staging-${randomSuffix()}`, "");
    const name = `s-${randomSuffix()}`;
    const out = (await planOf(name, [stagingApp("web")], { staging: chosen.id })) as Out;
    expect(out.createdStagingEnv).toBe(false);
    expect(out.stagingEnvironmentId).toBe(chosen.id);
  });

  test("a re-up without the flag keeps the stored staging env (and mints no second one)", async () => {
    const name = `s-${randomSuffix()}`;
    const first = (await planOf(name, [stagingApp("web")])) as Out;
    const before = db.getEnvironments().length;

    const second = (await planOf(name, [stagingApp("web")])) as Out;
    expect(second.stagingEnvironmentId).toBe(first.stagingEnvironmentId);
    expect(second.createdStagingEnv).toBe(false);
    expect(db.getEnvironments().length).toBe(before);
  });

  test("an explicit null clears the stored staging env", async () => {
    const name = `s-${randomSuffix()}`;
    await planOf(name, [stagingApp("web")]);
    const out = (await planOf(name, [app("web")], { staging: null })) as Out;
    expect(out.stagingEnvironmentId).toBeNull();
    expect(db.getStackByName(name)!.staging_environment_id).toBeNull();
  });

  test("every opted-in member resolves to the SAME stack staging env", async () => {
    const name = `s-${randomSuffix()}`;
    const out = (await planOf(name, [stagingApp("web"), stagingApp("api"), app("worker")])) as Out;
    expect(out.stagingByKey.web).toBe(out.stagingEnvironmentId);
    expect(out.stagingByKey.api).toBe(out.stagingEnvironmentId);
    // Not opted in → staging stays off for that member.
    expect(out.stagingByKey.worker).toBeNull();
  });

  test("rejects an unknown staging environment id", async () => {
    const name = `s-${randomSuffix()}`;
    await expect(planOf(name, [stagingApp("web")], { staging: 999_999 })).rejects.toThrow(
      /staging environment 999999 not found/i,
    );
  });

  test("rejects webhook.staging without webhook.enabled", async () => {
    const name = `s-${randomSuffix()}`;
    const broken = { ...app("web"), webhook_staging: true };
    await expect(planOf(name, [broken])).rejects.toThrow(/webhook\.enabled/i);
  });

  test("applies staging-only overrides after copying the production environment", async () => {
    const name = `s-${randomSuffix()}`;
    const input = {
      ...req(name, [stagingApp("web")]),
      env_vars: [{ key: "DATABASE_URL", value: "postgres://production" }],
      staging_env_vars: [{ key: "DATABASE_URL", value: "postgres://staging", secret: true }],
      staging_env_keys: ["DATABASE_URL"],
    } as StackDeployRequest;
    const out = await planStep.run(makeCtx(input), {}) as Out;
    const vars = await resolveEnvVarsForDeploy(db.getEnvironment(out.stagingEnvironmentId!)!.env_vars);
    expect(vars.DATABASE_URL).toBe("postgres://staging");
    expect(JSON.parse(db.getStackByName(name)!.staging_env_keys)).toEqual(["DATABASE_URL"]);
  });

  test("cannot certify a copied production key without applying a staging value", async () => {
    const name = `s-${randomSuffix()}`;
    const input = {
      ...req(name, [stagingApp("web")]),
      env_vars: [{ key: "DATABASE_URL", value: "postgres://production" }],
      staging_env_keys: ["DATABASE_URL"],
    } as StackDeployRequest;
    await planStep.run(makeCtx(input), {});
    expect(JSON.parse(db.getStackByName(name)!.staging_env_keys)).toEqual([]);
  });
});

describe("deploy_stack staging service removal", () => {
  test("disabling staging queues only the staging counterpart for removal", async () => {
    const name = `remove-stage-${randomSuffix()}`;
    const input = req(name, [app("web")], [{ key: "cache", type: "redis" }]);
    const parent = enqueueOperation({
      kind: "deploy_stack", resourceKeys: [`stack:${name}`], input, trigger: "test",
    });
    const ctx = makeCtx(input);
    ctx.opId = parent.id;
    const planOut = await planStep.run(ctx, {}) as any;
    const production = db.insertService({
      name: `${name}-cache`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}", stack_id: planOut.stackId,
    });
    const staging = db.insertService({
      name: `${name}-cache-staging`, service_type: "redis", version: "7", port: 6379,
      env_vars: "{}", credentials: "{}", stack_id: planOut.stackId,
      target: "staging", target_of: production.id, placement_pool: "staging",
    });
    const poll = setInterval(() => {
      for (const child of listChildOperations(parent.id)) {
        if (child.status !== "done") markOperationFinished(child.id, "done");
      }
    }, 5);
    try {
      await reconcileRemovalsStep.run(ctx, { plan: planOut });
    } finally {
      clearInterval(poll);
    }
    const destroys = listChildOperations(parent.id).filter((child) => child.kind === "destroy_service");
    expect(destroys).toHaveLength(1);
    expect(JSON.parse(destroys[0].input_json).serviceId).toBe(staging.id);
  });
});
