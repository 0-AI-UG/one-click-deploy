import { describe, expect, test } from "bun:test";
import { assertConnectedStatelessWorkload, assertProviderVolumesSupported, serverCapabilities } from "./infrastructure.ts";

describe("server infrastructure capabilities", () => {
  test("managed Hetzner servers expose the narrow provider lifecycle capabilities", () => {
    expect(serverCapabilities({ provider: "hetzner", ownership: "managed" })).toEqual({
      providerLifecycle: true,
      providerVolumes: true,
      providerNetwork: true,
      providerFirewall: true,
    });
  });

  test("connected servers are stateless and never provider-owned", () => {
    expect(serverCapabilities({ provider: "external", ownership: "connected" })).toEqual({
      providerLifecycle: false,
      providerVolumes: false,
      providerNetwork: false,
      providerFirewall: false,
    });
    expect(() => assertProviderVolumesSupported({
      name: "external-1",
      provider: "external",
      ownership: "connected",
    })).toThrow(/does not support OCD-managed volumes or managed services/);
    expect(() => assertConnectedStatelessWorkload(
      { name: "external-1", provider: "external", ownership: "connected" },
      { managedVolume: false, hostMounts: true },
    )).toThrow(/only stateless app containers/);
  });
});
