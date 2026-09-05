import { describe, expect, test } from "bun:test";
import { serverCapabilities } from "./infrastructure.ts";

describe("server infrastructure capabilities", () => {
  test("managed Hetzner servers expose the narrow provider lifecycle capabilities", () => {
    expect(serverCapabilities({ provider: "hetzner", ownership: "managed" })).toEqual({
      providerLifecycle: true,
      providerVolumes: true,
      providerNetwork: true,
      providerFirewall: true,
    });
  });

  test("connected servers have no provider-owned infrastructure capabilities", () => {
    expect(serverCapabilities({ provider: "external", ownership: "connected" })).toEqual({
      providerLifecycle: false,
      providerVolumes: false,
      providerNetwork: false,
      providerFirewall: false,
    });
  });
});
