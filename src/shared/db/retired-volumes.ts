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
  retention_class: "user" | "provisional";
};

export function retireVolume(data: {
  providerVolumeId: string;
  formerResourceType: "app";
  formerResourceId: number;
  formerResourceName: string;
  reason: string;
  retentionClass?: "user" | "provisional";
}): RetiredVolumeRow {
  return db.query(
    `INSERT INTO retired_volumes
      (provider_volume_id, former_resource_type, former_resource_id, former_resource_name, reason, retention_class)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_volume_id) DO UPDATE SET
        reason = excluded.reason,
        state = 'detached',
        retired_at = datetime('now'),
        purge_after = datetime('now', '+7 days'),
        retention_class = excluded.retention_class
      RETURNING *`,
  ).get(
    data.providerVolumeId,
    data.formerResourceType,
    data.formerResourceId,
    data.formerResourceName,
    data.reason,
    data.retentionClass ?? "user",
  ) as RetiredVolumeRow;
}

export function getRetiredVolumes(): RetiredVolumeRow[] {
  return db.query("SELECT * FROM retired_volumes ORDER BY retired_at DESC").all() as RetiredVolumeRow[];
}

/**
 * Only operation-owned provisional volumes are eligible for unattended
 * cleanup. Volumes retained after an explicit app destroy remain
 * user-owned and require the normal browser-confirmed deletion flow.
 */
export function getExpiredProvisionalVolumes(): RetiredVolumeRow[] {
  return db.query(
    `SELECT * FROM retired_volumes
     WHERE state = 'detached'
       AND retention_class = 'provisional'
       AND purge_after <= datetime('now')
     ORDER BY purge_after ASC`,
  ).all() as RetiredVolumeRow[];
}

export function deleteRetiredVolume(providerVolumeId: string): void {
  db.query("DELETE FROM retired_volumes WHERE provider_volume_id = ?").run(providerVolumeId);
}
