import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import { enqueueOperation, insertStep } from "../shared/db/operations.ts";
import { appendOpLog, getFilteredOpLogs } from "./op-logger.ts";

describe("operation log filtering", () => {
  test("same-timestamp adjacent steps classify against the latest sequence", () => {
    const op = enqueueOperation({ kind: "deploy", resourceKeys: ["app:1"], input: {}, trigger: "test" });
    // SQLite's datetime defaults have one-second precision, so both rows and
    // the log deliberately share a timestamp. The higher sequence is the
    // active phase and must win instead of allowing both filters to match.
    insertStep({ opId: op.id, seq: 1, step: "build", phase: "forward", status: "ok" });
    insertStep({ opId: op.id, seq: 2, step: "transfer", phase: "forward", status: "started" });
    appendOpLog(op.id, "info", "uploaded 5/10 MiB");

    expect(getFilteredOpLogs(op.id, { phase: "build" })).toHaveLength(0);
    expect(getFilteredOpLogs(op.id, { phase: "transfer" }).map((row) => row.message))
      .toEqual(["uploaded 5/10 MiB"]);
    expect(getFilteredOpLogs(op.id, { phase: "forward" })).toHaveLength(1);
  });
});
