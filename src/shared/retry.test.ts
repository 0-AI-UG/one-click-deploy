import { describe, test, expect, mock } from "bun:test";
import { withRetry, isRetryableHttpError, isRetryableSshError } from "./retry.ts";

describe("withRetry", () => {
  test("returns on first success", async () => {
    const fn = mock(() => Promise.resolve("ok"));
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure then succeeds", async () => {
    let attempt = 0;
    const fn = mock(() => {
      attempt++;
      if (attempt < 3) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    });
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws after exhausting retries", async () => {
    const fn = mock(() => Promise.reject(new Error("always fail")));
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 })
    ).rejects.toThrow("always fail");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("respects retryOn predicate", async () => {
    const fn = mock(() => Promise.reject(new Error("client error 400")));
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        retryOn: () => false,
      })
    ).rejects.toThrow("client error 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("converts non-Error throws to Error", async () => {
    const fn = mock(() => Promise.reject("string error"));
    await expect(
      withRetry(fn, { maxAttempts: 1, baseDelayMs: 10 })
    ).rejects.toThrow("string error");
  });
});

describe("isRetryableHttpError", () => {
  test("retries on 429/500/502/503", () => {
    expect(isRetryableHttpError(new Error("Hetzner API error 429: rate limited"))).toBe(true);
    expect(isRetryableHttpError(new Error("Hetzner API error 500: internal"))).toBe(true);
    expect(isRetryableHttpError(new Error("Hetzner API error 502: bad gateway"))).toBe(true);
    expect(isRetryableHttpError(new Error("Hetzner API error 503: unavailable"))).toBe(true);
  });

  test("does not retry on 400/401/403/404", () => {
    expect(isRetryableHttpError(new Error("Hetzner API error 400: bad request"))).toBe(false);
    expect(isRetryableHttpError(new Error("Hetzner API error 401: unauthorized"))).toBe(false);
    expect(isRetryableHttpError(new Error("Hetzner API error 403: forbidden"))).toBe(false);
    expect(isRetryableHttpError(new Error("Hetzner API error 404: not found"))).toBe(false);
  });

  test("retries on network errors", () => {
    expect(isRetryableHttpError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableHttpError(new Error("fetch failed"))).toBe(true);
  });
});

describe("isRetryableSshError", () => {
  test("retries on connection issues", () => {
    expect(isRetryableSshError(new Error("Connection refused"))).toBe(true);
    expect(isRetryableSshError(new Error("Connection timed out"))).toBe(true);
    expect(isRetryableSshError(new Error("No route to host"))).toBe(true);
  });

  test("does not retry on other errors", () => {
    expect(isRetryableSshError(new Error("Permission denied"))).toBe(false);
    expect(isRetryableSshError(new Error("Command failed"))).toBe(false);
  });
});
