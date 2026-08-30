import db from "./connection.ts";

export const BUILD_MIN_FREE_BYTES = 12 * 1024 ** 3;
export const BUILD_LEASE_TTL_SECONDS = 120;
export const BUILD_OBSERVATION_MAX_AGE_SECONDS = 60;

export type BuildWorkerLeaseRow = {
  worker_id: number;
  slot: number;
  operation_id: number;
  lease_token: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
};

export function getBuildWorkerLeaseForOperation(operationId: number): BuildWorkerLeaseRow | null {
  return db.query("SELECT * FROM build_worker_leases WHERE operation_id = ?")
    .get(operationId) as BuildWorkerLeaseRow | null;
}

export function getActiveBuildWorkerLease(workerId: number, slot = 0): BuildWorkerLeaseRow | null {
  return db.query(
    `SELECT * FROM build_worker_leases
     WHERE worker_id = ? AND slot = ? AND unixepoch(expires_at) > unixepoch('now')`,
  ).get(workerId, slot) as BuildWorkerLeaseRow | null;
}

export function listActiveBuildWorkerLeases(workerId?: number): BuildWorkerLeaseRow[] {
  if (workerId === undefined) {
    return db.query(
      "SELECT * FROM build_worker_leases WHERE unixepoch(expires_at) > unixepoch('now') ORDER BY worker_id, slot",
    ).all() as BuildWorkerLeaseRow[];
  }
  return db.query(
    `SELECT * FROM build_worker_leases
     WHERE worker_id = ? AND unixepoch(expires_at) > unixepoch('now') ORDER BY slot`,
  ).all(workerId) as BuildWorkerLeaseRow[];
}

function eligibleWorker(
  workerId: number,
  minFreeBytes: number,
  observationMaxAgeSeconds: number,
): boolean {
  const row = db.query(
    `SELECT id FROM build_workers
     WHERE id = ? AND status = 'online' AND draining = 0 AND disk_free_bytes >= ?
       AND last_checked_at IS NOT NULL
       AND unixepoch(last_checked_at) >= unixepoch('now') - ?`,
  ).get(workerId, minFreeBytes, observationMaxAgeSeconds);
  return !!row;
}

function expiryModifier(ttlSeconds: number): string {
  return `+${Math.max(1, Math.floor(ttlSeconds))} seconds`;
}

export function tryAcquireBuildWorkerLease(args: {
  operationId: number;
  candidateWorkerIds: number[];
  minFreeBytes?: number;
  observationMaxAgeSeconds?: number;
  ttlSeconds?: number;
}): BuildWorkerLeaseRow | null {
  const minFreeBytes = args.minFreeBytes ?? BUILD_MIN_FREE_BYTES;
  const observationMaxAgeSeconds = args.observationMaxAgeSeconds ?? BUILD_OBSERVATION_MAX_AGE_SECONDS;
  const ttlSeconds = args.ttlSeconds ?? BUILD_LEASE_TTL_SECONDS;
  const candidates = [...new Set(args.candidateWorkerIds)];

  return db.transaction(() => {
    db.query(
      `DELETE FROM build_worker_leases
       WHERE operation_id IN (
         SELECT id FROM operations
         WHERE status IN ('done','failed','cancelled','compensated','compensation_failed')
       )`,
    ).run();

    const existing = getBuildWorkerLeaseForOperation(args.operationId);
    if (existing && candidates.includes(existing.worker_id) &&
      eligibleWorker(existing.worker_id, minFreeBytes, observationMaxAgeSeconds)) {
      if (Date.parse(existing.expires_at.replace(" ", "T") + "Z") > Date.now()) {
        db.query(
          `UPDATE build_worker_leases
           SET heartbeat_at = datetime('now'), expires_at = datetime('now', ?)
           WHERE operation_id = ? AND lease_token = ?`,
        ).run(expiryModifier(ttlSeconds), args.operationId, existing.lease_token);
        return getBuildWorkerLeaseForOperation(args.operationId);
      }
      db.query("DELETE FROM build_worker_leases WHERE operation_id = ?").run(args.operationId);
    } else if (existing) {
      db.query("DELETE FROM build_worker_leases WHERE operation_id = ?").run(args.operationId);
    }

    db.query("DELETE FROM build_worker_leases WHERE unixepoch(expires_at) <= unixepoch('now')").run();

    for (const workerId of candidates) {
      if (!eligibleWorker(workerId, minFreeBytes, observationMaxAgeSeconds)) continue;
      const leaseToken = crypto.randomUUID();
      try {
        const lease = db.query(
          `INSERT INTO build_worker_leases
            (worker_id, slot, operation_id, lease_token, expires_at)
           VALUES (?, 0, ?, ?, datetime('now', ?)) RETURNING *`,
        ).get(workerId, args.operationId, leaseToken, expiryModifier(ttlSeconds)) as BuildWorkerLeaseRow;
        db.query("UPDATE build_workers SET last_used_at = datetime('now') WHERE id = ?").run(workerId);
        return lease;
      } catch {
        // Another operation owns this slot; continue through the scored list.
      }
    }
    return null;
  })();
}

export function heartbeatBuildWorkerLease(args: {
  operationId: number;
  leaseToken: string;
  ttlSeconds?: number;
}): boolean {
  const result = db.query(
    `UPDATE build_worker_leases
     SET heartbeat_at = datetime('now'), expires_at = datetime('now', ?)
     WHERE operation_id = ? AND lease_token = ?
       AND unixepoch(expires_at) > unixepoch('now')`,
  ).run(expiryModifier(args.ttlSeconds ?? BUILD_LEASE_TTL_SECONDS), args.operationId, args.leaseToken);
  return result.changes === 1;
}

export function releaseBuildWorkerLease(args: { operationId: number; leaseToken: string }): boolean {
  const result = db.query(
    "DELETE FROM build_worker_leases WHERE operation_id = ? AND lease_token = ?",
  ).run(args.operationId, args.leaseToken);
  return result.changes === 1;
}

export function reapTerminalBuildWorkerLeases(): number {
  const result = db.query(
    `DELETE FROM build_worker_leases
     WHERE operation_id IN (
       SELECT id FROM operations
       WHERE status IN ('done','failed','cancelled','compensated','compensation_failed')
     )`,
  ).run();
  return result.changes;
}
