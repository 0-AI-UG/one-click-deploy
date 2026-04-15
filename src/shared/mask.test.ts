import { describe, test, expect } from "bun:test";
import { createMasker, maskEnvValues } from "./mask.ts";

describe("createMasker", () => {
  test("masks exact matches", () => {
    const mask = createMasker(["my-secret-token"]);
    expect(mask("Bearer my-secret-token")).toBe("Bearer ***");
  });

  test("masks multiple occurrences", () => {
    const mask = createMasker(["secret"]);
    expect(mask("secret and secret again")).toBe("*** and *** again");
  });

  test("masks multiple different secrets", () => {
    const mask = createMasker(["token1", "token2"]);
    expect(mask("token1 and token2")).toBe("*** and ***");
  });

  test("handles regex special chars in secrets", () => {
    const mask = createMasker(["abc.def+ghi"]);
    expect(mask("value abc.def+ghi end")).toBe("value *** end");
    expect(mask("value abcXdefXghi end")).toBe("value abcXdefXghi end");
  });

  test("returns identity for empty secrets", () => {
    const mask = createMasker([]);
    expect(mask("some text")).toBe("some text");
  });

  test("skips secrets shorter than 4 chars", () => {
    const mask = createMasker(["ab", "abc", "abcdefgh"]);
    expect(mask("ab abc abcdefgh")).toBe("ab abc ***");
  });

  test("handles empty text", () => {
    const mask = createMasker(["secret"]);
    expect(mask("")).toBe("");
  });
});

describe("maskEnvValues", () => {
  test("masks env var values in text", () => {
    const text = "Connecting with password super-secret-value to db";
    const result = maskEnvValues(text, { DB_PASSWORD: "super-secret-value" });
    expect(result).toBe("Connecting with password *** to db");
  });

  test("does not mask keys", () => {
    const text = "Setting DB_PASSWORD=hidden";
    const result = maskEnvValues(text, { DB_PASSWORD: "hidden" });
    expect(result).toBe("Setting DB_PASSWORD=***");
  });

  test("handles empty env vars", () => {
    const text = "some text";
    expect(maskEnvValues(text, {})).toBe("some text");
  });
});
