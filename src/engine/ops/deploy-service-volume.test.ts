import { describe, expect, test } from "bun:test";
import {
  assertAdoptableServiceVolume,
  serviceVolumeName,
} from "./deploy-service.ts";

describe("deploy_service volume identity", () => {
  test("new service volumes are immutable-operation scoped", () => {
    expect(serviceVolumeName("postgres", 41)).toBe("ocd-svc-postgres-op41");
    expect(serviceVolumeName("postgres", 41)).not.toBe(serviceVolumeName("postgres", 42));
  });

  test("rejects retained and mismatched same-name volumes instead of adopting them", () => {
    const volume = {
      providerId: "vol-old",
      sizeGb: 10,
      location: "fsn1",
      serverId: null,
    };
    expect(() => assertAdoptableServiceVolume(
      volume,
      { sizeGb: 10, location: "fsn1", serverId: "srv-1" },
      [{
        provider_volume_id: "vol-old",
        former_resource_type: "service",
        former_resource_name: "postgres",
      }],
    )).toThrow(/Refusing to adopt retained volume/);

    expect(() => assertAdoptableServiceVolume(
      { ...volume, providerId: "vol-wrong", sizeGb: 20 },
      { sizeGb: 10, location: "fsn1", serverId: "srv-1" },
      [],
    )).toThrow(/does not match/);
  });
});
