// Tests for the in-memory per-resource scheduler used by the engine.
// Single-tenant: no DB-backed locks (no orgs in this branch). The scheduler
// tracks holders in process memory only.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-scheduler-test-"));

import { describe, test, expect, beforeEach } from "bun:test";
import { tryAcquire, release, currentHolder, heldKeys } from "./scheduler.ts";

// Drop any state leaked by a previous test. The scheduler module is
// process-global, so we explicitly clear keys we plan to use rather than
// reset the whole map.
function clear(keys: string[]) {
  release(keys);
}

describe("scheduler: tryAcquire / release", () => {
  test("returns ok for a fresh key", () => {
    const key = `fresh-${Date.now()}-a`;
    const r = tryAcquire([key], 1001, "noop");
    expect(r.ok).toBe(true);
    clear([key]);
  });

  test("second acquire on same key returns busy", () => {
    const key = `busy-${Date.now()}-b`;
    expect(tryAcquire([key], 2001, "noop").ok).toBe(true);
    const r = tryAcquire([key], 2002, "noop");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.busyKey).toBe(key);
      expect(r.heldBy.opId).toBe(2001);
    }
    clear([key]);
  });

  test("after release the key can be re-acquired", () => {
    const key = `reacq-${Date.now()}-c`;
    expect(tryAcquire([key], 3001, "noop").ok).toBe(true);
    release([key]);
    expect(tryAcquire([key], 3002, "noop").ok).toBe(true);
    clear([key]);
  });

  test("currentHolder reflects the holder", () => {
    const key = `holder-${Date.now()}-d`;
    tryAcquire([key], 4001, "deploy");
    const h = currentHolder(key);
    expect(h?.opId).toBe(4001);
    expect(h?.kind).toBe("deploy");
    clear([key]);
  });

  test("currentHolder returns null for an unheld key", () => {
    expect(currentHolder(`no-such-${Date.now()}`)).toBeNull();
  });
});

describe("scheduler: overlapping vs disjoint resource keys", () => {
  test("overlapping keys serialize: second op blocked while first holds", () => {
    const shared = `overlap-${Date.now()}`;
    expect(tryAcquire([shared], 5001, "noop").ok).toBe(true);
    expect(tryAcquire([shared], 5002, "noop").ok).toBe(false);

    release([shared]);
    expect(tryAcquire([shared], 5002, "noop").ok).toBe(true);
    clear([shared]);
  });

  test("disjoint keys allow both ops to hold concurrently", () => {
    const a = `disjoint-a-${Date.now()}`;
    const b = `disjoint-b-${Date.now()}`;
    expect(tryAcquire([a], 6001, "noop").ok).toBe(true);
    expect(tryAcquire([b], 6002, "noop").ok).toBe(true);
    clear([a, b]);
  });

  test("partial overlap fails atomically without acquiring any key", () => {
    const a = `partial-a-${Date.now()}`;
    const b = `partial-b-${Date.now()}`;
    expect(tryAcquire([a], 7001, "noop").ok).toBe(true);

    // op2 wants both a and b; should fail because a is held — and must NOT
    // grab b as a side effect.
    const r = tryAcquire([a, b], 7002, "noop");
    expect(r.ok).toBe(false);
    // b should still be free.
    expect(currentHolder(b)).toBeNull();
    expect(tryAcquire([b], 7003, "noop").ok).toBe(true);
    clear([a, b]);
  });
});

describe("scheduler: heldKeys snapshot", () => {
  test("heldKeys lists only currently-held keys", () => {
    const k = `held-${Date.now()}`;
    expect(heldKeys().some((h) => h.key === k)).toBe(false);
    tryAcquire([k], 8001, "noop");
    expect(heldKeys().some((h) => h.key === k && h.holder.opId === 8001)).toBe(true);
    release([k]);
    expect(heldKeys().some((h) => h.key === k)).toBe(false);
  });
});
