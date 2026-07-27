import { describe, expect, test } from "bun:test";
import {
  formatFallbackProgress,
  handleTransientFollowError,
  newFollowRetryState,
  resetFollowRetryState,
} from "./ops.ts";

describe("operation follow fallback", () => {
  test("deduplicates reconnect warnings during one continuous outage", async () => {
    const state = newFollowRetryState();
    const lines: string[] = [];
    const noSleep = async () => {};
    expect(await handleTransientFollowError(state, (line) => lines.push(line), {
      sleep: noSleep,
      progress: "last step build at 2026-07-27 10:00:00",
    })).toBe(true);
    expect(await handleTransientFollowError(state, (line) => lines.push(line), {
      sleep: noSleep,
      progress: "last step build at 2026-07-27 10:00:00",
    })).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("polling operation state");

    resetFollowRetryState(state);
    await handleTransientFollowError(state, (line) => lines.push(line), { sleep: noSleep });
    expect(lines).toHaveLength(2);
  });

  test("fallback progress includes the last step and its timestamp", () => {
    expect(formatFallbackProgress({
      id: 7,
      status: "running",
      last_step: "health_check",
      error: null,
      started_at: "2026-07-27T09:00:00Z",
      finished_at: null,
      steps: [{
        seq: 4,
        step: "health_check",
        phase: "forward",
        status: "started",
        detail: "",
        started_at: "2026-07-27T10:03:04Z",
        finished_at: null,
      }],
    })).toBe("last step health_check at 2026-07-27 10:03:04");
  });
});
