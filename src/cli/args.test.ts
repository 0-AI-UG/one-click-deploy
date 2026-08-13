import { describe, expect, test } from "bun:test";
import { parseCliArgs, positiveIntegerFlag } from "./args.ts";

describe("parseCliArgs", () => {
  const schema = {
    tail: { type: "string" as const },
    follow: { type: "boolean" as const, aliases: ["f"] },
    set: { type: "string" as const, repeatable: true },
  };

  test("accepts separated and equals value forms", () => {
    expect(parseCliArgs(["app", "--tail", "100", "-f"], schema, { maxPositionals: 1 })).toEqual({
      positionals: ["app"], flags: { tail: "100", follow: true },
    });
    expect(parseCliArgs(["app", "--tail=100"], schema, { maxPositionals: 1 }).flags.tail).toBe("100");
  });

  test("retains repeated values", () => {
    expect(parseCliArgs(["--set=A=1", "--set", "B=2"], schema).flags.set).toEqual(["A=1", "B=2"]);
  });

  test("rejects unknown, missing and extra arguments", () => {
    expect(() => parseCliArgs(["--wat"], schema)).toThrow("Unknown option");
    expect(() => parseCliArgs(["--tail"], schema)).toThrow("requires a value");
    expect(() => parseCliArgs(["a", "b"], schema, { maxPositionals: 1 })).toThrow("Unexpected argument");
  });

  test("validates positive integer flags", () => {
    expect(positiveIntegerFlag("42", "tail", { max: 100 })).toBe(42);
    expect(() => positiveIntegerFlag("2x", "tail")).toThrow("positive integer");
    expect(() => positiveIntegerFlag("101", "tail", { max: 100 })).toThrow("1 to 100");
  });
});
