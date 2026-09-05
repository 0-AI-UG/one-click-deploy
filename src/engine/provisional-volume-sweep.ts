import * as db from "../shared/db.ts";
import { isNotFoundError } from "../shared/providers/errors.ts";
import { requireStorageDriver, type StorageVolume } from "./storage/index.ts";

const AUTOMATION_ACTOR = "system:provisional-volume-sweeper";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [reconciler:volume-sweep]`, ...args);
}

function liveOwners(providerVolumeId: string): string[] {
  const owners = db.getApps()
    .filter((app) => app.volume_id === providerVolumeId)
    .map((app) => `app:${app.name}`);
  const panel = db.getPanel();
  if (panel?.volume_id === providerVolumeId) owners.push(`panel:${panel.name}`);
  return owners;
}

/**
 * Permanently removes only expired, detached volumes classified as provisional
 * failed-deploy artifacts. User-retained volumes never enter this query and
 * continue to require explicit browser-confirmed deletion.
 */
export async function sweepExpiredProvisionalVolumes(): Promise<number> {
  const candidates = db.getExpiredProvisionalVolumes();
  if (candidates.length === 0) return 0;
  let deleted = 0;

  for (const retired of candidates) {
    const owners = liveOwners(retired.provider_volume_id);
    if (owners.length > 0) {
      log(`skip ${retired.provider_volume_id}: referenced by ${owners.join(", ")}`);
      continue;
    }

    const driver = requireStorageDriver(retired.driver_id);
    let volume: StorageVolume | null = null;
    try {
      volume = await driver.inspect(retired.provider_volume_id);
    } catch (error) {
      if (!isNotFoundError(error)) {
        log(`inspect ${retired.provider_volume_id} failed: ${error}`);
        continue;
      }
    }

    if (driver.portable && volume?.attachedServerId) {
      log(`skip ${retired.provider_volume_id}: storage driver reports it attached to server ${volume.attachedServerId}`);
      continue;
    }

    const audit = db.beginVolumeDeletionAudit({
      actorUserId: AUTOMATION_ACTOR,
      providerVolumeId: retired.provider_volume_id,
      driverId: retired.driver_id,
      providerVolumeName: volume?.name ?? "(already absent)",
      formerResourceType: retired.former_resource_type,
      formerResourceId: retired.former_resource_id,
      formerResourceName: retired.former_resource_name,
      retentionState: retired.state,
      retiredAt: retired.retired_at,
      purgeAfter: retired.purge_after,
    });

    try {
      if (volume) await driver.delete(retired.provider_volume_id);
      db.finishVolumeDeletionAudit(audit.id);
      db.deleteRetiredVolume(retired.provider_volume_id);
      deleted++;
      log(`deleted expired provisional volume ${retired.provider_volume_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.finishVolumeDeletionAudit(audit.id, message);
      log(`delete ${retired.provider_volume_id} failed: ${message}`);
    }
  }

  return deleted;
}
