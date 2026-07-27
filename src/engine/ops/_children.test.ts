import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import {
  enqueueOperation,
  markOperationFinished,
} from "../../shared/db/operations.ts";
import type { OpContext } from "../types.ts";
import { awaitChildren } from "./_children.ts";

describe("awaitChildren", () => {
  test("treats compensation_failed as terminal and propagates failure", async () => {
    const parent = enqueueOperation({
      kind: "test_parent",
      resourceKeys: ["test:parent"],
      input: {},
      trigger: "test",
    });
    const child = enqueueOperation({
      kind: "test_child",
      resourceKeys: ["test:child"],
      input: {},
      trigger: "test",
      parentId: parent.id,
    });
    markOperationFinished(child.id, "compensation_failed", { message: "rollback failed" });

    let parked = 0;
    const ctx = {
      opId: parent.id,
      kind: parent.kind,
      input: {},
      trigger: "test",
      triggeredBy: "",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: () => {},
      park: () => { parked++; },
      unpark: () => { parked--; },
    } satisfies OpContext;

    await expect(awaitChildren(ctx)).rejects.toThrow(
      `1 child op(s) failed (succeeded=0): #${child.id} test_child: rollback failed`,
    );
    expect(parked).toBe(0);
  });
});
