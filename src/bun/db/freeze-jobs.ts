import db from "./connection.ts";

export type FreezeJobState =
  | "pending"
  | "snapshotting"
  | "finalizing"
  | "done"
  | "cancelled"
  | "failed";

export type FreezeJobRow = {
  id: number;
  server_id: number;
  state: FreezeJobState;
  snapshot_id: string;
  started_at: string;
  finished_at: string | null;
  error: string;
};

/**
 * Enqueue a freeze job for a server. If an unterminated job already exists
 * for the same server, that row is returned instead of a duplicate — the
 * freeze worker is idempotent and only wants one in-flight job per server.
 */
export function enqueueFreezeJob(serverId: number): FreezeJobRow {
  const existing = db
    .query(
      "SELECT * FROM freeze_jobs WHERE server_id = ? AND state IN ('pending','snapshotting','finalizing') ORDER BY id DESC LIMIT 1",
    )
    .get(serverId) as FreezeJobRow | null;
  if (existing) return existing;
  return db
    .query(
      "INSERT INTO freeze_jobs (server_id, state) VALUES (?, 'pending') RETURNING *",
    )
    .get(serverId) as FreezeJobRow;
}

export function getFreezeJob(id: number): FreezeJobRow | null {
  return db
    .query("SELECT * FROM freeze_jobs WHERE id = ?")
    .get(id) as FreezeJobRow | null;
}

export function getActiveFreezeJobForServer(
  serverId: number,
): FreezeJobRow | null {
  return db
    .query(
      "SELECT * FROM freeze_jobs WHERE server_id = ? AND state IN ('pending','snapshotting','finalizing') ORDER BY id DESC LIMIT 1",
    )
    .get(serverId) as FreezeJobRow | null;
}

export function listActiveFreezeJobs(): FreezeJobRow[] {
  return db
    .query(
      "SELECT * FROM freeze_jobs WHERE state IN ('pending','snapshotting','finalizing') ORDER BY id ASC",
    )
    .all() as FreezeJobRow[];
}

export function updateFreezeJobState(
  id: number,
  state: FreezeJobState,
  fields: { snapshot_id?: string; error?: string } = {},
): void {
  const sets: string[] = ["state = ?"];
  const values: (string | number | null)[] = [state];
  if (fields.snapshot_id !== undefined) {
    sets.push("snapshot_id = ?");
    values.push(fields.snapshot_id);
  }
  if (fields.error !== undefined) {
    sets.push("error = ?");
    values.push(fields.error);
  }
  if (state === "done" || state === "cancelled" || state === "failed") {
    sets.push("finished_at = datetime('now')");
  }
  values.push(id);
  db.query(`UPDATE freeze_jobs SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}
