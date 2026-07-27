import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";

describe("volume deletion audit", () => {
  test("records the pre-delete ownership snapshot and completion", () => {
    const providerId = `volume-${randomSuffix()}`;
    const row = db.beginVolumeDeletionAudit({
      actorUserId: "operator-1",
      providerVolumeId: providerId,
      providerVolumeName: "ocd-api-data",
      formerResourceType: "app",
      formerResourceId: 42,
      formerResourceName: "api",
      retentionState: "detached",
      retiredAt: "2026-07-20 10:00:00",
      purgeAfter: "2026-07-27 10:00:00",
    });
    expect(row.status).toBe("pending");

    db.finishVolumeDeletionAudit(row.id);
    const stored = db.getVolumeDeletionAudit().find((item) => item.id === row.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.provider_volume_id).toBe(providerId);
    expect(stored?.former_resource_name).toBe("api");
    expect(stored?.completed_at).toBeTruthy();
  });

  test("retains provider failures instead of losing the attempted action", () => {
    const row = db.beginVolumeDeletionAudit({
      actorUserId: "operator-2",
      providerVolumeId: `volume-${randomSuffix()}`,
      providerVolumeName: "important-data",
    });
    db.finishVolumeDeletionAudit(row.id, "provider refused delete");
    const stored = db.getVolumeDeletionAudit().find((item) => item.id === row.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toBe("provider refused delete");
  });
});
