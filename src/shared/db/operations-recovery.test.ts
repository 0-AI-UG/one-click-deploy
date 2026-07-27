import { useTempDataDir } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import {
  enqueueOperation,
  findSupersedingOperation,
  finalizeOperation,
  getOperation,
  markOperationFinished,
  requeueOperation,
  retryOperationAsNew,
} from "./operations.ts";

describe("operation recovery persistence", () => {
  test("resumes failed compensation on the same durable operation", () => {
    const op = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: ["stack:demo"],
      input: { name: "demo" },
      trigger: "test",
    });
    markOperationFinished(op.id, "compensation_failed", { message: "cleanup failed" });

    const resumed = requeueOperation(op.id)!;
    expect(resumed.id).toBe(op.id);
    expect(resumed.status).toBe("compensating");
    expect(resumed.finished_at).toBeNull();
    expect(resumed.error_json).toBeNull();
  });

  test("a retry of a terminal operation is a fresh top-level audit row", () => {
    const parent = enqueueOperation({
      kind: "parent",
      resourceKeys: ["stack:parent"],
      input: {},
      trigger: "test",
    });
    const op = enqueueOperation({
      kind: "redeploy",
      resourceKeys: ["app:9"],
      input: { appId: 9 },
      trigger: "test",
      parentId: parent.id,
    });
    markOperationFinished(op.id, "failed", { message: "build failed" });

    const retry = retryOperationAsNew(op.id, "operator")!;
    expect(retry.id).not.toBe(op.id);
    expect(retry.parent_id).toBeNull();
    expect(retry.trigger).toBe("retry");
    expect(retry.triggered_by).toBe("operator");
    expect(JSON.parse(retry.input_json)).toEqual({ appId: 9 });
  });

  test("operator finalization records an explicit terminal audit state", () => {
    const op = enqueueOperation({
      kind: "test",
      resourceKeys: ["test:1"],
      input: {},
      trigger: "test",
    });
    const finalized = finalizeOperation(op.id, "failed", "resources did not converge")!;

    expect(finalized.status).toBe("failed");
    expect(JSON.parse(finalized.error_json!)).toMatchObject({
      finalized: true,
      message: "resources did not converge",
    });
    expect(getOperation(op.id)?.finished_at).not.toBeNull();
  });

  test("ownership follows a resource from create-name key to durable numeric id", () => {
    const name = `owned-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const create = enqueueOperation({
      kind: "deploy",
      resourceKeys: [`app:create:${name}`],
      input: { app_name: name },
      trigger: "test",
    });
    const app = db.insertApp({
      name,
      domain: `${name}.example.com`,
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const adopt = enqueueOperation({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "test",
    });

    expect(findSupersedingOperation(create)?.id).toBe(adopt.id);
  });
});
