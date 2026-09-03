import { describe, expect, test } from "bun:test";
import { parseCopyArgs } from "./cp.ts";

describe("cp CLI parsing", () => {
  test("parses an app file download", () => {
    expect(parseCopyArgs(["database:/tmp/archive.tar.gz", "./archive.tar.gz", "--replica=7"])).toEqual({
      target: "database",
      remotePath: "/tmp/archive.tar.gz",
      destination: "./archive.tar.gz",
      force: false,
      targetFlags: ["--replica=7"],
    });
  });

  test("requires an absolute remote path", () => {
    expect(() => parseCopyArgs(["database:tmp/file", "./file"])).toThrow("absolute");
  });

  test("rejects unknown options", () => {
    expect(() => parseCopyArgs(["database:/tmp/file", "./file", "--wat"])).toThrow("Unknown option");
  });
});
