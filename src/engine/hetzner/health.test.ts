import { describe, expect, test } from "bun:test";
import {
  assessContainerInspection,
  assessMarkerFreshness,
  dockerExecScriptCommand,
  isExpectedHttpStatus,
  parseContainerInspection,
} from "./health.ts";

describe("HTTP readiness status contract", () => {
  test("rejects 404 by default and accepts only explicitly declared statuses", () => {
    expect(isExpectedHttpStatus(200)).toBe(true);
    expect(isExpectedHttpStatus(404)).toBe(false);
    expect(isExpectedHttpStatus(204, [200, 204])).toBe(true);
  });
});

describe("docker container state health", () => {
  test("parses full docker state rather than only State.Running", () => {
    expect(parseContainerInspection(
      "running\ttrue\tfalse\t2\t2026-07-27T10:00:00.000000000Z",
    )).toEqual({
      status: "running",
      running: true,
      restarting: false,
      restartCount: 2,
      startedAt: "2026-07-27T10:00:00.000000000Z",
    });
  });

  test("marks Docker restarting unhealthy even if Running is reported true", () => {
    const result = assessContainerInspection({
      status: "restarting",
      running: true,
      restarting: true,
      restartCount: 3,
      startedAt: null,
    });
    expect(result.runnable).toBe(false);
    expect(result.error).toContain("restarting");
  });

  test("marks exited containers unhealthy", () => {
    expect(assessContainerInspection({
      status: "exited",
      running: false,
      restarting: false,
      restartCount: 0,
      startedAt: null,
    }).runnable).toBe(false);
  });

  test("marks a recent excessive restart loop unhealthy", () => {
    const now = Date.parse("2026-07-27T10:04:00Z");
    const result = assessContainerInspection({
      status: "running",
      running: true,
      restarting: false,
      restartCount: 7,
      startedAt: "2026-07-27T10:03:00Z",
    }, now);
    expect(result.runnable).toBe(false);
    expect(result.error).toContain("restarted 7 times");
  });

  test("allows a formerly unstable container after the stability window", () => {
    const now = Date.parse("2026-07-27T10:10:00Z");
    expect(assessContainerInspection({
      status: "running",
      running: true,
      restarting: false,
      restartCount: 7,
      startedAt: "2026-07-27T10:00:00Z",
    }, now).runnable).toBe(true);
  });
});

describe("service exec command transport", () => {
  test("preserves scripts containing nested single and double quotes", () => {
    const script = `psql -c "DO \\$\\$ BEGIN RAISE NOTICE 'ready'; END \\$\\$;"`;
    const command = dockerExecScriptCommand("foody-postgres", script);
    const encoded = Buffer.from(script, "utf8").toString("base64");

    expect(command).toContain(encoded);
    expect(command).not.toContain(script);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(script);
  });

  test("rejects unsafe container names", () => {
    expect(() => dockerExecScriptCommand("db; reboot", "true")).toThrow("Invalid container name");
  });
});

describe("worker and periodic job freshness", () => {
  test("accepts a marker at the configured age boundary", () => {
    expect(assessMarkerFreshness(1_000, 60, 1_060)).toEqual({ fresh: true, ageSeconds: 60 });
  });

  test("rejects a stale marker", () => {
    expect(assessMarkerFreshness(1_000, 60, 1_061)).toEqual({ fresh: false, ageSeconds: 61 });
  });
});
