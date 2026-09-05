import { describe, expect, test } from "bun:test";
import {
  parseProviderAssignments,
  parseProviderConnections,
  providerSecretKey,
} from "./provider-connections.ts";

describe("provider connection settings", () => {
  test("invalid or partial assignment JSON safely becomes explicit empty assignments", () => {
    expect(parseProviderAssignments(undefined)).toEqual({ infrastructure: "", object_storage: "" });
    expect(parseProviderAssignments('{"object_storage":"s3-main"}')).toEqual({
      infrastructure: "",
      object_storage: "s3-main",
    });
    expect(parseProviderAssignments("not json")).toEqual({ infrastructure: "", object_storage: "" });
  });

  test("filters malformed and unknown provider records", () => {
    const raw = JSON.stringify([
      { id: "s3-main", kind: "s3-compatible", name: "S3", config: {}, created_at: "now" },
      { id: "bad id", kind: "s3-compatible", name: "bad", config: {}, created_at: "now" },
      { id: "mystery", kind: "unknown", name: "bad", config: {}, created_at: "now" },
    ]);
    expect(parseProviderConnections(raw).map((provider) => provider.id)).toEqual(["s3-main"]);
  });

  test("scopes encrypted credentials to a provider profile", () => {
    expect(providerSecretKey("hetzner-main", "api_token")).toBe("provider.hetzner-main.api_token");
    expect(() => providerSecretKey("../bad", "api_token")).toThrow("Invalid provider credential key");
  });
});
