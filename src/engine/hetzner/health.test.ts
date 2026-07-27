import { describe, expect, test } from "bun:test";
import {
  assessContainerInspection,
  parseContainerInspection,
} from "./health.ts";

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
