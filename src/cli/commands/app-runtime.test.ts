import { describe, expect, test } from "bun:test";
import { parseAppFlags } from "./app.ts";
import { parseRollbackArgs } from "./rollback.ts";

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

});
