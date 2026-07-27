import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import type { OpContext } from "../types.ts";
import destroyStackOp from "./destroy-stack.ts";

describe("destroy_stack environment ownership", () => {
  test("deletes the stack row but retains production and staging environments", async () => {
    const suffix = randomSuffix();
    const prod = db.insertEnvironment(`prod-${suffix}`, "");
    const staging = db.insertEnvironment(`staging-${suffix}`, "");
    const stack = db.insertStack({
      name: `stack-${suffix}`,
      environment_id: prod.id,
      staging_environment_id: staging.id,
    });
    const input = { stackId: stack.id };
    const logs: string[] = [];
    const ctx = {
      opId: 1,
      kind: "destroy_stack",
      input,
      trigger: "test",
      triggeredBy: "tester",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: (line: string) => logs.push(line),
      park: () => {},
      unpark: () => {},
    } satisfies OpContext<typeof input>;

    const step = destroyStackOp.steps.find((s) => s.name === "delete_stack_row")!;
    await step.run(ctx, {});

    expect(db.getStack(stack.id)).toBeNull();
    expect(db.getEnvironment(prod.id)).not.toBeNull();
    expect(db.getEnvironment(staging.id)).not.toBeNull();
    expect(logs.join("\n")).toContain("environments are only deleted explicitly");
  });
});
