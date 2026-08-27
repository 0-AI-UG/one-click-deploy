import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  markOperationFinished,
} from "../../shared/db/operations.ts";
import {
  findLatestRelatedStackOperation,
  stackLockKeys,
  withOwningStackKeys,
} from "./stack-operations.ts";
import { release, tryAcquire } from "../../engine/scheduler.ts";

function fixture() {
  const name = `ops-stack-${randomSuffix()}`;
  const env = db.insertEnvironment(`${name}-env`, "{}");
  const stack = db.insertStack({ name, environment_id: env.id });
  const app = db.insertApp({
    name: `${name}-web`,
    domain: "",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
  db.setAppStack(app.id, stack.id);
  return { stack, env, app };
}

describe("stack operation association and locking", () => {
  test("HTTP member operations inherit both durable stack lock identities", () => {
    const { stack, app } = fixture();
    const args = withOwningStackKeys({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "cli",
    });

    expect(args.resourceKeys).toContain(`app:${app.id}`);
    expect(args.resourceKeys).toEqual(expect.arrayContaining(stackLockKeys(stack)));

    // Regression guard: destroy/reconcile and member operations
    // contend on a shared key instead of running concurrently.
    const overlap = args.resourceKeys.filter((key) => stackLockKeys(stack).includes(key));
    expect(overlap).toHaveLength(2);
    expect(tryAcquire(stackLockKeys(stack), 101, "destroy_stack").ok).toBe(true);
    try {
      const competing = tryAcquire(args.resourceKeys, 102, "redeploy");
      expect(competing.ok).toBe(false);
      if (!competing.ok) expect(competing.heldBy.kind).toBe("destroy_stack");
    } finally {
      release(stackLockKeys(stack));
    }
  });

  test("latest environment or member failure supersedes the original stack op", () => {
    const { stack, env, app } = fixture();
    const deployed = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: stackLockKeys(stack),
      input: { name: stack.name },
      trigger: "test",
    });
    markOperationFinished(deployed.id, "done");
    const cascade = enqueueOperation({
      kind: "cascade_redeploy",
      resourceKeys: [`env:${env.id}`],
      input: { environmentId: env.id },
      trigger: "test",
    });
    markOperationFinished(cascade.id, "failed", { message: "environment rollout failed" });
    const member = enqueueOperation({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "test",
    });
    markOperationFinished(member.id, "failed", { message: "member rollout failed" });

    expect(findLatestRelatedStackOperation(stack)?.id).toBe(member.id);
    expect(findLatestRelatedStackOperation(stack)?.status).toBe("failed");
  });

  test("a stack child resolves to its parent operation for stack status", () => {
    const { stack, app } = fixture();
    const parent = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: stackLockKeys(stack),
      input: { name: stack.name },
      trigger: "test",
    });
    const child = enqueueOperation({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "stack",
      parentId: parent.id,
    });
    markOperationFinished(child.id, "failed", { message: "renderer failed" });

    expect(findLatestRelatedStackOperation(stack)?.id).toBe(parent.id);
  });
});
