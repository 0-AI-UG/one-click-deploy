import db from "./connection.ts";

export type RetiredVolumeRow = {
  id: number;
  provider_volume_id: string;
  former_resource_type: string;
  former_resource_id: number;
  former_resource_name: string;
  reason: string;
  state: string;
  retired_at: string;
  purge_after: string;
};

export function retireVolume(data: {
  providerVolumeId: string;
  formerResourceType: "app" | "service";
  formerResourceId: number;
  formerResourceName: string;
  reason: string;
}): RetiredVolumeRow {
  return db.query(
    `INSERT INTO retired_volumes
      (provider_volume_id, former_resource_type, former_resource_id, former_resource_name, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_volume_id) DO UPDATE SET
        reason = excluded.reason,
        state = 'detached',
        retired_at = datetime('now'),
        purge_after = datetime('now', '+7 days')
      RETURNING *`,
  ).get(
    data.providerVolumeId,
    data.formerResourceType,
    data.formerResourceId,
    data.formerResourceName,
    data.reason,
  ) as RetiredVolumeRow;
}

export function getRetiredVolumes(): RetiredVolumeRow[] {
  return db.query("SELECT * FROM retired_volumes ORDER BY retired_at DESC").all() as RetiredVolumeRow[];
}

export function deleteRetiredVolume(providerVolumeId: string): void {
  db.query("DELETE FROM retired_volumes WHERE provider_volume_id = ?").run(providerVolumeId);
}
