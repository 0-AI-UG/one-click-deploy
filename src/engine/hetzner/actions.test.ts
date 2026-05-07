// Unit tests for pollAction — Hetzner action polling with success/error/
// timeout and the optional successAtProgress short-circuit.
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the hetznerApi so we can feed a scripted sequence of responses.
type ActionResp = { action: { status: string; progress: number; error?: { message: string } } };
let queue: ActionResp[] = [];
const hetznerApi = mock(async (_path: string) => {
  if (queue.length === 0) throw new Error("hetznerApi called with empty queue");
  return queue.shift()!;
});
mock.module("./api.ts", () => ({ hetznerApi }));

import { pollAction } from "./actions.ts";

beforeEach(() => {
  queue = [];
  hetznerApi.mockClear();
});

describe("pollAction", () => {
  test("returns when status becomes 'success'", async () => {
    queue.push({ action: { status: "running", progress: 10 } });
    queue.push({ action: { status: "success", progress: 100 } });

    await pollAction(123, { intervalMs: 1, timeoutMs: 5_000 });

    expect(hetznerApi).toHaveBeenCalledTimes(2);
    expect(hetznerApi).toHaveBeenCalledWith("/actions/123");
  });

  test("throws with the action error message when status is 'error'", async () => {
    queue.push({ action: { status: "error", progress: 50, error: { message: "volume busy" } } });

    await expect(pollAction(7, { intervalMs: 1, timeoutMs: 5_000 })).rejects.toThrow(
      "Operation failed: volume busy"
    );
  });

  test("throws 'Unknown error' when error object is missing on error status", async () => {
    queue.push({ action: { status: "error", progress: 50 } });

    await expect(pollAction(8, { intervalMs: 1, timeoutMs: 5_000 })).rejects.toThrow(
      "Operation failed: Unknown error"
    );
  });

  test("times out if the action never reaches a terminal state", async () => {
    // Stay 'running' forever — rely on tight timeout.
    for (let i = 0; i < 100; i++) queue.push({ action: { status: "running", progress: 0 } });

    await expect(pollAction(9, { intervalMs: 5, timeoutMs: 30 })).rejects.toThrow(
      /Operation timed out/
    );
  });

  test("successAtProgress: treats progress >= threshold as success", async () => {
    queue.push({ action: { status: "running", progress: 10 } });
    queue.push({ action: { status: "running", progress: 55 } });

    await pollAction(10, { intervalMs: 1, timeoutMs: 5_000, successAtProgress: 50 });

    // Should return after the second poll (progress 55 >= 50) without needing success.
    expect(hetznerApi).toHaveBeenCalledTimes(2);
  });

  test("successAtProgress does not fire when progress is below threshold", async () => {
    queue.push({ action: { status: "running", progress: 20 } });
    queue.push({ action: { status: "success", progress: 100 } });

    await pollAction(11, { intervalMs: 1, timeoutMs: 5_000, successAtProgress: 90 });

    // First poll is below threshold (20 < 90), second transitions to success.
    expect(hetznerApi).toHaveBeenCalledTimes(2);
  });

  test("success status wins over successAtProgress check on the same tick", async () => {
    // status=success is checked before the progress threshold, so this should
    // return on the first poll regardless of progress value.
    queue.push({ action: { status: "success", progress: 0 } });

    await pollAction(12, { intervalMs: 1, timeoutMs: 5_000, successAtProgress: 50 });

    expect(hetznerApi).toHaveBeenCalledTimes(1);
  });
});
