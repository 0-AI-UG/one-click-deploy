import db from "./connection.ts";

export type VolumeDeletionAuditRow = {
  id: number;
  actor_user_id: string;
  provider_volume_id: string;
  provider_volume_name: string;
  former_resource_type: string;
  former_resource_id: number;
  former_resource_name: string;
  retention_state: string;
  retired_at: string | null;
  purge_after: string | null;
  status: "pending" | "completed" | "failed";
  error: string;
  requested_at: string;
  completed_at: string | null;
};

export function beginVolumeDeletionAudit(input: {
  actorUserId: string;
  providerVolumeId: string;
  providerVolumeName: string;
  formerResourceType?: string;
  formerResourceId?: number;
  formerResourceName?: string;
  retentionState?: string;
  retiredAt?: string | null;
  purgeAfter?: string | null;
}): VolumeDeletionAuditRow {
  return db.query(
    `INSERT INTO volume_deletion_audit
      (actor_user_id, provider_volume_id, provider_volume_name,
       former_resource_type, former_resource_id, former_resource_name,
       retention_state, retired_at, purge_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(
    input.actorUserId,
    input.providerVolumeId,
    input.providerVolumeName,
    input.formerResourceType ?? "",
    input.formerResourceId ?? 0,
    input.formerResourceName ?? "",
    input.retentionState ?? "",
    input.retiredAt ?? null,
    input.purgeAfter ?? null,
  ) as VolumeDeletionAuditRow;
}

export function finishVolumeDeletionAudit(id: number, error?: string): void {
  db.query(
    `UPDATE volume_deletion_audit
     SET status = ?, error = ?, completed_at = datetime('now')
     WHERE id = ?`,
  ).run(error ? "failed" : "completed", error ?? "", id);
}

export function getVolumeDeletionAudit(): VolumeDeletionAuditRow[] {
  return db.query(
    "SELECT * FROM volume_deletion_audit ORDER BY requested_at DESC, id DESC",
  ).all() as VolumeDeletionAuditRow[];
}
