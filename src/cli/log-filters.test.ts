import { describe, expect, test } from "bun:test";
import { parseLogArgs } from "./log-filters.ts";

describe("operation log flags", () => {
  test("accepts conventional separated filters", () => {
    const parsed = parseLogArgs(["12", "--tail", "100", "--child", "web", "--phase=build"]);
    expect(parsed.target).toBe("12");
    expect(parsed.tail).toBe(100);
    expect(parsed.child).toBe("web");
    expect(parsed.phase).toBe("build");
  });

  test("accepts duration and timestamp since values", () => {
    expect(parseLogArgs(["12", "--since", "2h"]).sinceTime).toMatch(/^\d{4}-/);
    expect(parseLogArgs(["12", "--since=2026-08-12T10:00:00Z"]).sinceTime).toBe("2026-08-12T10:00:00.000Z");
  });
});
