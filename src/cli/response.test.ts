import { describe, expect, test } from "bun:test";
import { expectArray, expectRecord, expectStringField } from "./response.ts";

describe("CLI response guards", () => {
  test("reject malformed successful payloads instead of rendering empty output", () => {
    expect(() => expectArray({}, "Apps request")).toThrow("malformed response");
    expect(() => expectRecord([], "Status request")).toThrow("malformed response");
    expect(() => expectStringField({}, "logs", "Logs request")).toThrow("missing string field logs");
  });
});
