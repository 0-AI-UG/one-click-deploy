import db from "./connection.ts";

export const BUILD_SOURCE_DELIVERY_STATUSES = [
  "received",
  "queued",
  "building",
  "deployed",
  "failed",
  "duplicate",
  "stale",
  "superseded",
] as const;

export type BuildSourceDeliveryStatus = typeof BUILD_SOURCE_DELIVERY_STATUSES[number];

export type BuildSourceDeliveryRow = {
  id: number;
  source_id: number;
  delivery_id: string;
  commit_sha: string;
  event_at: string | null;
  received_at: string;
  operation_id: number | null;
  status: BuildSourceDeliveryStatus;
  superseded_by: number | null;
};

const TERMINAL_STATUSES: BuildSourceDeliveryStatus[] = [
  "deployed",
  "failed",
  "duplicate",
  "stale",
  "superseded",
];

const ALLOWED_TRANSITIONS: Record<BuildSourceDeliveryStatus, ReadonlySet<BuildSourceDeliveryStatus>> = {
  received: new Set(["received", "queued", "building", "failed", "duplicate", "stale", "superseded"]),
  queued: new Set(["queued", "building", "failed", "duplicate", "stale", "superseded"]),
  building: new Set(["building", "deployed", "failed", "superseded"]),
  deployed: new Set(["deployed"]),
  failed: new Set(["failed"]),
  duplicate: new Set(["duplicate"]),
  stale: new Set(["stale"]),
  superseded: new Set(["superseded"]),
};

function assertSourceId(sourceId: number): void {
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error("Build source delivery sourceId must be a positive integer");
  }
}

function assertNonEmptyTrimmed(value: string, name: string): void {
  if (!value || value !== value.trim()) {
    throw new Error(`Build source delivery ${name} must be non-empty and trimmed`);
  }
}

export function getBuildSourceDelivery(
  sourceId: number,
  deliveryId: string,
): BuildSourceDeliveryRow | null {
  return db.query(
    "SELECT * FROM build_source_deliveries WHERE source_id = ? AND delivery_id = ?",
  ).get(sourceId, deliveryId) as BuildSourceDeliveryRow | null;
}

/** Return the latest delivery in event order, including terminal history. */
export function getLatestBuildSourceDelivery(sourceId: number): BuildSourceDeliveryRow | null {
  assertSourceId(sourceId);
  return db.query(
    `SELECT * FROM build_source_deliveries
     WHERE source_id = ?
     ORDER BY COALESCE(event_at, received_at) DESC, id DESC
     LIMIT 1`,
  ).get(sourceId) as BuildSourceDeliveryRow | null;
}

/**
 * Atomically records a delivery. A replay of the same immutable delivery
 * identity returns the original row; a conflicting replay is rejected.
 */
export function recordBuildSourceDelivery(args: {
  sourceId: number;
  deliveryId: string;
  commitSha: string;
  eventAt?: string | null;
}): { delivery: BuildSourceDeliveryRow; inserted: boolean } {
  assertSourceId(args.sourceId);
  assertNonEmptyTrimmed(args.deliveryId, "deliveryId");
  assertNonEmptyTrimmed(args.commitSha, "commitSha");
  const eventAt = args.eventAt ?? null;
  if (eventAt !== null) assertNonEmptyTrimmed(eventAt, "eventAt");

  return db.transaction(() => {
    const inserted = db.query(
      `INSERT INTO build_source_deliveries (source_id, delivery_id, commit_sha, event_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, delivery_id) DO NOTHING
       RETURNING *`,
    ).get(args.sourceId, args.deliveryId, args.commitSha, eventAt) as BuildSourceDeliveryRow | null;
    if (inserted) return { delivery: inserted, inserted: true };

    const existing = getBuildSourceDelivery(args.sourceId, args.deliveryId);
    if (!existing) throw new Error("Build source delivery insert conflicted but no row exists");
    if (existing.commit_sha !== args.commitSha || existing.event_at !== eventAt) {
      throw new Error(
        `Build source delivery identity mismatch for source ${args.sourceId} delivery ${args.deliveryId}`,
      );
    }
    return { delivery: existing, inserted: false };
  })();
}

/** Attach a durable operation once and advance a newly received delivery to queued. */
export function attachBuildSourceDeliveryOperation(args: {
  sourceId: number;
  deliveryId: string;
  operationId: number;
}): BuildSourceDeliveryRow {
  assertSourceId(args.sourceId);
  assertNonEmptyTrimmed(args.deliveryId, "deliveryId");
  if (!Number.isInteger(args.operationId) || args.operationId <= 0) {
    throw new Error("Build source delivery operationId must be a positive integer");
  }

  return db.transaction(() => {
    const delivery = getBuildSourceDelivery(args.sourceId, args.deliveryId);
    if (!delivery) throw new Error(`Unknown build source delivery ${args.deliveryId}`);
    if (delivery.operation_id !== null && delivery.operation_id !== args.operationId) {
      throw new Error(`Build source delivery ${args.deliveryId} is already attached to another operation`);
    }
    db.query(
      `UPDATE build_source_deliveries
       SET operation_id = ?,
           status = CASE WHEN status = 'received' THEN 'queued' ELSE status END
       WHERE id = ? AND (operation_id IS NULL OR operation_id = ?)`,
    ).run(args.operationId, delivery.id, args.operationId);
    return getBuildSourceDelivery(args.sourceId, args.deliveryId)!;
  })();
}

export function updateBuildSourceDeliveryStatus(args: {
  sourceId: number;
  deliveryId: string;
  status: BuildSourceDeliveryStatus;
  supersededByDeliveryId?: string | null;
}): BuildSourceDeliveryRow {
  assertSourceId(args.sourceId);
  assertNonEmptyTrimmed(args.deliveryId, "deliveryId");
  if (!BUILD_SOURCE_DELIVERY_STATUSES.includes(args.status)) {
    throw new Error(`Unknown build source delivery status ${args.status}`);
  }

  return db.transaction(() => {
    const delivery = getBuildSourceDelivery(args.sourceId, args.deliveryId);
    if (!delivery) throw new Error(`Unknown build source delivery ${args.deliveryId}`);
    if (!ALLOWED_TRANSITIONS[delivery.status].has(args.status)) {
      throw new Error(`Invalid build source delivery transition ${delivery.status} -> ${args.status}`);
    }

    let supersededBy: number | null = null;
    if (args.status === "superseded" && args.supersededByDeliveryId) {
      const newer = getBuildSourceDelivery(args.sourceId, args.supersededByDeliveryId);
      if (!newer) throw new Error(`Unknown superseding build source delivery ${args.supersededByDeliveryId}`);
      if (newer.id === delivery.id) throw new Error("A build source delivery cannot supersede itself");
      supersededBy = newer.id;
    }
    db.query(
      "UPDATE build_source_deliveries SET status = ?, superseded_by = ? WHERE id = ?",
    ).run(args.status, supersededBy, delivery.id);
    return getBuildSourceDelivery(args.sourceId, args.deliveryId)!;
  })();
}

export function listActiveBuildSourceDeliveries(sourceId: number): BuildSourceDeliveryRow[] {
  assertSourceId(sourceId);
  return db.query(
    `SELECT * FROM build_source_deliveries
     WHERE source_id = ? AND status IN ('received', 'queued', 'building')
     ORDER BY COALESCE(event_at, received_at) DESC, received_at DESC, id DESC`,
  ).all(sourceId) as BuildSourceDeliveryRow[];
}

/** List queued deliveries that precede the named delivery in event order. */
export function listOlderQueuedBuildSourceDeliveries(args: {
  sourceId: number;
  newerDeliveryId: string;
}): BuildSourceDeliveryRow[] {
  assertSourceId(args.sourceId);
  const newer = getBuildSourceDelivery(args.sourceId, args.newerDeliveryId);
  if (!newer) throw new Error(`Unknown build source delivery ${args.newerDeliveryId}`);
  return db.query(
    `SELECT * FROM build_source_deliveries
     WHERE source_id = ?
       AND status = 'queued'
       AND (
         COALESCE(event_at, received_at) < COALESCE(?, ?)
         OR (COALESCE(event_at, received_at) = COALESCE(?, ?) AND id < ?)
       )
     ORDER BY COALESCE(event_at, received_at) DESC, received_at DESC, id DESC`,
  ).all(
    args.sourceId,
    newer.event_at,
    newer.received_at,
    newer.event_at,
    newer.received_at,
    newer.id,
  ) as BuildSourceDeliveryRow[];
}

/** Supersede not-yet-building deliveries older than the named delivery. */
export function markOlderBuildSourceDeliveriesSuperseded(args: {
  sourceId: number;
  newerDeliveryId: string;
}): number {
  assertSourceId(args.sourceId);
  return db.transaction(() => {
    const newer = getBuildSourceDelivery(args.sourceId, args.newerDeliveryId);
    if (!newer) throw new Error(`Unknown build source delivery ${args.newerDeliveryId}`);
    return db.query(
      `UPDATE build_source_deliveries
       SET status = 'superseded', superseded_by = ?
       WHERE source_id = ?
         AND status IN ('received', 'queued')
         AND id <> ?
         AND (
           COALESCE(event_at, received_at) < COALESCE(?, ?)
           OR (COALESCE(event_at, received_at) = COALESCE(?, ?) AND id < ?)
         )`,
    ).run(
      newer.id,
      args.sourceId,
      newer.id,
      newer.event_at,
      newer.received_at,
      newer.event_at,
      newer.received_at,
      newer.id,
    ).changes;
  })();
}

/** Keep the newest rows for a source plus every non-terminal row. */
export function compactBuildSourceDeliveries(sourceId: number, keepNewest = 100): number {
  assertSourceId(sourceId);
  if (!Number.isInteger(keepNewest) || keepNewest < 0) {
    throw new Error("Build source delivery keepNewest must be a non-negative integer");
  }
  const terminalPlaceholders = TERMINAL_STATUSES.map(() => "?").join(", ");
  return db.query(
    `DELETE FROM build_source_deliveries
     WHERE source_id = ?
       AND status IN (${terminalPlaceholders})
       AND id NOT IN (
         SELECT id FROM build_source_deliveries
         WHERE source_id = ?
         ORDER BY COALESCE(event_at, received_at) DESC, received_at DESC, id DESC
         LIMIT ?
       )`,
  ).run(sourceId, ...TERMINAL_STATUSES, sourceId, keepNewest).changes;
}
