import { describe, expect, test } from "bun:test";
import { parseAppFlags } from "./app.ts";
import { parseRollbackArgs } from "./rollback.ts";
import { parsePolicyBody } from "./scale.ts";

describe("app runtime CLI parsing", () => {
  test("parses positional arguments, values and switches", () => {
    const parsed = parseAppFlags(["api", "--port=3000", "--disable-auth"]);
    expect(parsed.positional).toEqual(["api"]);
    expect(parsed.values.get("port")).toBe("3000");
    expect(parsed.switches.has("disable-auth")).toBe(true);
  });

  test("parses a selected rollback deployment", () => {
    expect(parseRollbackArgs(["api", "--deployment=42"])).toEqual({
      appName: "api",
      deploymentId: 42,
    });
  });

  test("merges policy flags over the current policy", () => {
    const current = {
      autoscale_enabled: false,
      min_replicas: 1,
      max_replicas: 3,
      cpu_threshold: 70,
      mem_threshold: 80,
      cooldown: 300,
      scale_to_zero_after: 300,
      req_threshold: 0,
    };
    const result = parsePolicyBody(
      parseAppFlags(["api", "--enabled=true", "--min=0", "--idle=600"]),
      current,
    );
    expect(result).toEqual({
      ...current,
      autoscale_enabled: true,
      min_replicas: 0,
      scale_to_zero_after: 600,
    });
  });

  test("does not advertise an unenforced server-placement flag", async () => {
    // Parsing still recognizes the flag so the command can return a precise
    // backend-capability error rather than silently ignoring placement.
    expect(parseAppFlags(["api", "2", "--server=7"]).values.get("server")).toBe("7");
  });
});
