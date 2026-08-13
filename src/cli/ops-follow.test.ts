import { describe, expect, test } from "bun:test";
import {
  formatFallbackProgress,
  handleTransientFollowError,
  newFollowRetryState,
  resetFollowRetryState,
  summarizeOperationError,
  formatOperationHeartbeat,
} from "./ops.ts";

describe("operation follow fallback", () => {
  test("error summaries retain the final relevant build lines", () => {
    const summary = summarizeOperationError(
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
      3,
    );
    expect(summary).toBe("line 18\nline 19\nline 20");
  });

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

  test("heartbeat identifies the active child, phase, elapsed time and last update", () => {
    const line = formatOperationHeartbeat({
      status: "running", last_step: "deploy_children", error: null, steps: [],
      started_at: "2026-08-12T09:00:00Z",
      latest_log: { ts: "2026-08-12T09:01:55Z", message: "uploaded 200/500 MiB" },
      children: [{
        id: 9, label: "Deploy app", resource_labels: ["web"], status: "running",
        last_step: "transfer", started_at: "2026-08-12T09:00:30Z",
      }],
    }, Date.parse("2026-08-12T09:02:00Z"));
    expect(line).toContain("web: transfer");
    expect(line).toContain("1m 30s elapsed");
    expect(line).toContain("5s since update");
    expect(line).toContain("uploaded 200/500 MiB");
  });
});
