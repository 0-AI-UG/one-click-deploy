import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, spyOn } from "bun:test";

// The sibling-cascade step touches neither hosts nor providers, but destroy-app
// imports both at module scope — stub them so the op can be loaded in-process.
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  removeContainer: mock(async () => {}),
}));
mock.module("../scale/traefik-manager.ts", () => ({ syncAllTraefik: mock(async () => {}) }));

import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations, markOperationFinished } from "../../shared/db/operations.ts";
import destroyAppOp from "./destroy-app.ts";
import type { OpContext } from "../types.ts";

type Input = { appId: number };

const siblingStep = destroyAppOp.steps.find((s) => s.name === "destroy_staging_sibling")!;

function makeCtx(input: Input, opId: number): OpContext<Input> {
  return {
    opId,
    kind: "destroy_app",
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

function seedApp(name: string) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
}

function parentOp(appId: number) {
  return enqueueOperation({
    kind: "destroy_app",
    resourceKeys: [`app:${appId}`],
    input: { appId },
    trigger: "test",
  });
}

/** Stand in for the engine: drive every child op to `done`. */
async function withWorker<T>(parentId: number, fn: () => Promise<T>): Promise<T> {
  const poll = setInterval(() => {
    for (const c of listChildOperations(parentId)) {
      if (c.status !== "done") markOperationFinished(c.id, "done");
    }
  }, 20);
  try {
    return await fn();
  } finally {
    clearInterval(poll);
  }
}

describe("destroy_app staging-sibling cascade", () => {
  test("enqueues a child destroy_app for the hidden staging sibling", async () => {
    const suffix = randomSuffix();
    const prod = seedApp(`a-${suffix}`);
    const sib = seedApp(`a-${suffix}-staging`);
    db.setAppTarget(sib.id, prod.id, "staging");
    const parent = parentOp(prod.id);

    const out = (await withWorker(parent.id, () =>
      siblingStep.run(makeCtx({ appId: prod.id }, parent.id), {}),
    )) as any;

    expect(out.ok).toBe(true);
    const children = listChildOperations(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe("destroy_app");
    expect(JSON.parse(children[0].input_json)).toEqual({ appId: sib.id });
    expect(children[0].resource_keys).toContain(`app:${sib.id}`);
  }, 30000);

  test("is a no-op for an app with no staging sibling", async () => {
    const prod = seedApp(`a-${randomSuffix()}`);
    const parent = parentOp(prod.id);
    const out = (await siblingStep.run(makeCtx({ appId: prod.id }, parent.id), {})) as any;
    expect(out).toEqual({ ok: true, childIds: [] });
    expect(listChildOperations(parent.id)).toHaveLength(0);
  });

  test("does not recurse: a staging sibling never looks for a sibling of its own", async () => {
    const suffix = randomSuffix();
    const prod = seedApp(`a-${suffix}`);
    const sib = seedApp(`a-${suffix}-staging`);
    db.setAppTarget(sib.id, prod.id, "staging");
    // Destroying the SIBLING itself (the child op this cascade enqueues).
    const parent = parentOp(sib.id);
    const out = (await siblingStep.run(makeCtx({ appId: sib.id }, parent.id), {})) as any;
    expect(out).toEqual({ ok: true, childIds: [] });
    expect(listChildOperations(parent.id)).toHaveLength(0);
  });

  test("is a no-op when the app row is already gone (resume-safe)", async () => {
    const parent = parentOp(999999);
    const out = (await siblingStep.run(makeCtx({ appId: 999999 }, parent.id), {})) as any;
    expect(out).toEqual({ ok: true, childIds: [] });
  });

  test("reuses the previous attempt's child instead of enqueuing a second destroy", async () => {
    const suffix = randomSuffix();
    const prod = seedApp(`a-${suffix}`);
    const sib = seedApp(`a-${suffix}-staging`);
    db.setAppTarget(sib.id, prod.id, "staging");
    const parent = parentOp(prod.id);
    const ctx = makeCtx({ appId: prod.id }, parent.id);

    const first = (await withWorker(parent.id, () => siblingStep.run(ctx, {}))) as any;
    const second = (await withWorker(parent.id, () => siblingStep.run(ctx, {}))) as any;

    expect(listChildOperations(parent.id)).toHaveLength(1);
    expect(second.childIds).toEqual(first.childIds);
  }, 30000);

  test("still adopts its child on resume after the sibling row is already gone", async () => {
    // The child's whole job is to delete the sibling row, so a resumed parent
    // routinely finds it missing. It must still adopt and await that child
    // rather than reporting "nothing to cascade to" and racing ahead to tear
    // down production while the sibling destroy is still in flight.
    const suffix = randomSuffix();
    const prod = seedApp(`a-${suffix}`);
    const sib = seedApp(`a-${suffix}-staging`);
    db.setAppTarget(sib.id, prod.id, "staging");
    const parent = parentOp(prod.id);
    const ctx = makeCtx({ appId: prod.id }, parent.id);

    const first = (await withWorker(parent.id, () => siblingStep.run(ctx, {}))) as any;
    expect(first.childIds).toHaveLength(1);

    db.deleteApp(sib.id); // the child did its job

    const resumed = (await withWorker(parent.id, () => siblingStep.run(ctx, {}))) as any;
    expect(resumed.childIds).toEqual(first.childIds);
    expect(listChildOperations(parent.id)).toHaveLength(1);
  }, 30000);
});

describe("destructive DB cleanup gates", () => {
  test("destroy_app records a DB deletion failure and the final gate rejects success", async () => {
    const app = seedApp(`db-fail-${randomSuffix()}`);
    const parent = parentOp(app.id);
    const ctx = makeCtx({ appId: app.id }, parent.id);
    const deleteRows = destroyAppOp.steps.find((s) => s.name === "delete_db_rows")!;
    const gate = destroyAppOp.steps.find((s) => s.name === "assert_db_cleanup")!;
    const deleteSpy = spyOn(db, "deleteApp").mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });
    try {
      const output = await deleteRows.run(ctx, {});
      expect(output).toMatchObject({ ok: false, failed: true });
      expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
      await expect(gate.run(ctx, { delete_db_rows: output })).rejects.toThrow(/cleanup incomplete/i);
    } finally {
      deleteSpy.mockRestore();
    }
  });

});
