import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";

const compute = makeFakeComputeProvider();
mock.module("../shared/providers/index.ts", () => ({ hetzner: compute }));

import sql, * as db from "../shared/db.ts";
import { sweepExpiredProvisionalVolumes } from "./provisional-volume-sweep.ts";

function retire(retentionClass: "user" | "provisional") {
  const providerVolumeId = `vol-${retentionClass}-${randomSuffix()}`;
  db.retireVolume({
    providerVolumeId,
    formerResourceType: "service",
    formerResourceId: 0,
    formerResourceName: `resource-${randomSuffix()}`,
    reason: "test",
    retentionClass,
  });
  sql.query("UPDATE retired_volumes SET purge_after = datetime('now', '-1 day') WHERE provider_volume_id = ?")
    .run(providerVolumeId);
  return providerVolumeId;
}

beforeEach(() => {
  compute._mocks.volumeDelete.mockClear();
  compute.volumes!.get = async (id) => ({
    providerId: id,
    name: "detached",
    sizeGb: 10,
    location: "fsn1",
    serverId: null,
  });
});

describe("expired provisional volume cleanup", () => {
  test("deletes expired failed-deploy volumes but preserves user-retained volumes", async () => {
    const userVolume = retire("user");
    const provisionalVolume = retire("provisional");

    expect(db.getExpiredProvisionalVolumes().map((row) => row.provider_volume_id))
      .toContain(provisionalVolume);
    expect(db.getExpiredProvisionalVolumes().map((row) => row.provider_volume_id))
      .not.toContain(userVolume);

    expect(await sweepExpiredProvisionalVolumes()).toBe(1);
    expect(compute._mocks.volumeDelete).toHaveBeenCalledWith(provisionalVolume);
    expect(db.getRetiredVolumes().some((row) => row.provider_volume_id === provisionalVolume)).toBe(false);
    expect(db.getRetiredVolumes().some((row) => row.provider_volume_id === userVolume)).toBe(true);
    expect(db.getVolumeDeletionAudit().find((row) => row.provider_volume_id === provisionalVolume))
      .toMatchObject({ status: "completed", actor_user_id: "system:provisional-volume-sweeper" });
  });

  test("does not delete a provider-attached provisional volume", async () => {
    const volumeId = retire("provisional");
    compute.volumes!.get = async (id) => ({
      providerId: id,
      name: "attached",
      sizeGb: 10,
      location: "fsn1",
      serverId: "server-1",
    });

    expect(await sweepExpiredProvisionalVolumes()).toBe(0);
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
    expect(db.getRetiredVolumes().some((row) => row.provider_volume_id === volumeId)).toBe(true);
  });
});
