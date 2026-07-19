// Unit tests for the availability SLO layer: the meets-target predicate the
// reconciler sampler and the API route share, plus uptime%/MTTR aggregation.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-avail-test-"));

import { describe, test, expect, beforeEach } from "bun:test";
import {
  computeMeetsTarget,
  getAvailabilityStats,
  insertAvailabilitySample,
} from "./availability.ts";
import { insertApp } from "./apps.ts";
import conn from "./connection.ts";

function makeApp() {
  return insertApp({
    name: `app-${Math.random().toString(36).slice(2, 8)}`,
    domain: "x.example.com",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

beforeEach(() => {
  conn.run("DELETE FROM availability_samples");
  conn.run("DELETE FROM apps");
});

describe("computeMeetsTarget", () => {
  // A "healthy" 2-replica app across 2 hosts / 2 locations.
  const base = {
    running_count: 2,
    distinct_hosts: 2,
    distinct_locations: 2,
    min_replicas: 2,
    min_locations: 1,
    max_per_host: 0,
  };

  test("running below the replica floor → false", () => {
    expect(computeMeetsTarget({ ...base, running_count: 1 })).toBe(false);
  });

  test("fewer distinct locations than min_locations → false", () => {
    expect(computeMeetsTarget({ ...base, min_locations: 2, distinct_locations: 1 })).toBe(false);
    expect(computeMeetsTarget({ ...base, min_locations: 2, distinct_locations: 2 })).toBe(true);
  });

  test("max_per_host cap requires enough distinct hosts", () => {
    // 2 replicas, cap 1/host → needs 2 hosts. One host fails, two passes.
    const capped = { running_count: 2, distinct_locations: 1, min_replicas: 2, min_locations: 1, max_per_host: 1 };
    expect(computeMeetsTarget({ ...capped, distinct_hosts: 1 })).toBe(false);
    expect(computeMeetsTarget({ ...capped, distinct_hosts: 2 })).toBe(true);
  });

  test("max_per_host:0 ignores host spread entirely", () => {
    expect(
      computeMeetsTarget({
        running_count: 3,
        distinct_hosts: 1,
        distinct_locations: 1,
        min_replicas: 1,
        min_locations: 1,
        max_per_host: 0,
      }),
    ).toBe(true);
  });

  test("min_replicas:0 is treated as a floor of 1", () => {
    const spread = { distinct_hosts: 1, distinct_locations: 1, min_replicas: 0, min_locations: 1, max_per_host: 0 };
    expect(computeMeetsTarget({ ...spread, running_count: 1 })).toBe(true);
    expect(computeMeetsTarget({ ...spread, running_count: 0 })).toBe(false);
  });
});

describe("getAvailabilityStats", () => {
  test("no samples → zeros and nulls", () => {
    const app = makeApp();
    expect(getAvailabilityStats(app.id, 86400)).toEqual({
      uptimePct: 0,
      mttrSeconds: null,
      sampleCount: 0,
      lastMeetsTarget: null,
    });
  });

  test("uptimePct = meets/total, lastMeetsTarget from the newest sample", () => {
    const app = makeApp();
    const sample = (meets: boolean) =>
      insertAvailabilitySample({
        app_id: app.id,
        meets_target: meets,
        desired_count: 2,
        running_count: meets ? 2 : 0,
        distinct_hosts: meets ? 2 : 0,
        distinct_locations: meets ? 1 : 0,
      });
    sample(true);
    sample(true);
    sample(true);
    sample(false); // newest
    const s = getAvailabilityStats(app.id, 86400);
    expect(s.sampleCount).toBe(4);
    expect(s.uptimePct).toBe(75);
    expect(s.lastMeetsTarget).toBe(false);
  });

  // Insert rows with explicit sampled_at (the public insert stamps server-side),
  // to exercise the downtime-run → recovery MTTR math deterministically.
  function insertAt(appId: number, sampledAt: string, meets: 0 | 1) {
    conn.run(
      "INSERT INTO availability_samples (app_id, meets_target, desired_count, running_count, distinct_hosts, distinct_locations, sampled_at) VALUES (?, ?, 2, ?, ?, ?, ?)",
      [appId, meets, meets ? 2 : 0, meets ? 2 : 0, meets ? 1 : 0, sampledAt],
    );
  }
  // Wide window so the crafted 2026-01 timestamps fall inside it regardless of
  // the real "now".
  const WIDE_WINDOW = 400 * 24 * 3600;

  test("MTTR = span from first failing sample to the recovering sample", () => {
    const app = makeApp();
    // meets, fail(+60s), fail(+120s), recover(+180s) → outage 00:01:00 → 00:03:00 = 120s.
    insertAt(app.id, "2026-01-01 00:00:00", 1);
    insertAt(app.id, "2026-01-01 00:01:00", 0);
    insertAt(app.id, "2026-01-01 00:02:00", 0);
    insertAt(app.id, "2026-01-01 00:03:00", 1);
    const s = getAvailabilityStats(app.id, WIDE_WINDOW);
    expect(s.mttrSeconds).toBe(120);
    expect(s.lastMeetsTarget).toBe(true);
    expect(s.uptimePct).toBe(50); // 2 of 4 meet
  });

  test("MTTR averages multiple recovered outages", () => {
    const app = makeApp();
    // outage A: 00:01 → 00:02 (60s); outage B: 00:04 → 00:06 (120s); mean = 90s.
    insertAt(app.id, "2026-01-01 00:00:00", 1);
    insertAt(app.id, "2026-01-01 00:01:00", 0);
    insertAt(app.id, "2026-01-01 00:02:00", 1);
    insertAt(app.id, "2026-01-01 00:03:00", 1);
    insertAt(app.id, "2026-01-01 00:04:00", 0);
    insertAt(app.id, "2026-01-01 00:05:00", 0);
    insertAt(app.id, "2026-01-01 00:06:00", 1);
    expect(getAvailabilityStats(app.id, WIDE_WINDOW).mttrSeconds).toBe(90);
  });

  test("an outage still open at window end contributes no MTTR", () => {
    const app = makeApp();
    insertAt(app.id, "2026-01-01 00:00:00", 1);
    insertAt(app.id, "2026-01-01 00:01:00", 0);
    insertAt(app.id, "2026-01-01 00:02:00", 0); // never recovers
    const s = getAvailabilityStats(app.id, WIDE_WINDOW);
    expect(s.mttrSeconds).toBeNull();
    expect(s.lastMeetsTarget).toBe(false);
  });
});
