import { describe, expect, test } from "bun:test";
import { operationAbort } from "./operation-abort.ts";

describe("operationAbort", () => {
  test("is already aborted when cancellation was requested", () => {
    const abort = operationAbort({ isCancelRequested: () => true });
    try {
      expect(abort.signal.aborted).toBe(true);
    } finally {
      abort.dispose();
    }
  });

  test("stays live for an active operation and can be disposed", () => {
    const abort = operationAbort({ isCancelRequested: () => false });
    expect(abort.signal.aborted).toBe(false);
    abort.dispose();
  });
});
