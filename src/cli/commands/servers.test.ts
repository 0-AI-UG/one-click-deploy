import { describe, expect, test } from "bun:test";
import { parseServerCreateArgs } from "./servers.ts";

describe("parseServerCreateArgs", () => {
  test("accepts equals and split option forms", () => {
    expect(parseServerCreateArgs([
      "--type=cx32",
      "--location",
      "fsn1",
      "--name=worker-1",
    ])).toEqual({
      ok: true,
      value: { serverType: "cx32", location: "fsn1", name: "worker-1" },
    });
  });

  test("requires type and location", () => {
    expect(parseServerCreateArgs(["--location=fsn1"])).toEqual({
      ok: false,
      error: "--type is required",
    });
    expect(parseServerCreateArgs(["--type=cx32"])).toEqual({
      ok: false,
      error: "--location is required",
    });
  });

  test("rejects unknown options", () => {
    expect(parseServerCreateArgs(["--type=cx32", "--location=fsn1", "--wat"])).toEqual({
      ok: false,
      error: "Unknown option: --wat",
    });
  });
});
