import db from "./connection.ts";
import * as health from "./_metrics-health.ts";

export type ReplicaRow = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  cpu_limit_cores: number;
  memory_used_mb: number;
  memory_limit_mb: number;
  unhealthy_ticks: number;
  last_health_at: string | null;
  stopped_at: string | null;
  image_digest: string;
  desired_image_digest: string;
  env_hash: string;
  config_revision: number;
  attested_at: string | null;
  attestation_error: string;
  created_at: string;
};

export type MetricSampleRow = {
  id: number;
  replica_id: number;
  app_id: number;
  cpu_percent: number;
  memory_percent: number;
  sampled_at: string;
};

export type ScalingEventRow = {
  id: number;
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason: string;
  created_at: string;
};

export function insertReplica(replica: {
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status?: string;
}): ReplicaRow {
  return db
    .query(
      "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      replica.app_id,
      replica.server_id,
      replica.host_port,
      replica.container_name,
      replica.status || "deploying"
    ) as ReplicaRow;
}

export function getReplicas(appId: number): ReplicaRow[] {
  return db
    .query("SELECT * FROM replicas WHERE app_id = ? ORDER BY created_at ASC")
    .all(appId) as ReplicaRow[];
}

export function getReplica(id: number): ReplicaRow | null {
  return db.query("SELECT * FROM replicas WHERE id = ?").get(id) as ReplicaRow | null;
}

export function getReplicasByServer(serverId: number): ReplicaRow[] {
  return db
    .query("SELECT * FROM replicas WHERE server_id = ?")
    .all(serverId) as ReplicaRow[];
}

export function updateReplicaStatus(id: number, status: string): void {
  health.updateStatus("replicas", id, status);
}

export function recordReplicaAttestation(
  id: number,
  attestation: {
    imageDigest: string;
    desiredImageDigest?: string;
    envHash: string;
    configRevision: number;
    error?: string;
  },
): void {
  db.query(
    `UPDATE replicas SET image_digest = ?, desired_image_digest = ?, env_hash = ?, config_revision = ?,
       attested_at = CASE WHEN ? = '' THEN datetime('now') ELSE NULL END,
       attestation_error = ?, status = CASE WHEN ? = '' THEN status ELSE 'divergent' END
     WHERE id = ?`,
  ).run(
    attestation.imageDigest,
    attestation.desiredImageDigest ?? attestation.imageDigest,
    attestation.envHash,
    attestation.configRevision,
    attestation.error || "",
    attestation.error || "",
    attestation.error || "",
    id,
  );
}

export function clearReplicaAttestation(id: number): void {
  db.query(
    "UPDATE replicas SET image_digest = '', desired_image_digest = '', env_hash = '', config_revision = 0, attested_at = NULL, attestation_error = '' WHERE id = ?",
  ).run(id);
}

export function markReplicaStopped(id: number): void {
  // Zero the metrics: a stopped container reports no docker stats, so the
  // reconciler would otherwise leave the last-seen values frozen and stale.
  db.query(
    `UPDATE replicas SET status = 'stopped', stopped_at = datetime('now'),
       cpu_percent = 0, memory_percent = 0,
       cpu_limit_cores = 0, memory_used_mb = 0, memory_limit_mb = 0
     WHERE id = ?`
  ).run(id);
}

export function markReplicaRunning(id: number): void {
  db.query(
    "UPDATE replicas SET status = 'running', stopped_at = NULL WHERE id = ?"
  ).run(id);
}

/** Absolute resource figures collected alongside the percentages. Optional so
 *  older callers/tests that only care about the percentages stay valid. */
export type ResourceUsage = {
  cpuLimitCores: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
};

export function updateReplicaMetrics(
  id: number,
  cpuPercent: number,
  memoryPercent: number,
  usage?: ResourceUsage,
): void {
  health.updateMetrics("replicas", id, cpuPercent, memoryPercent, usage);
}

export function deleteReplica(id: number): void {
  db.query("DELETE FROM replicas WHERE id = ?").run(id);
}

export function getAllReplicas(): ReplicaRow[] {
  return db.query("SELECT * FROM replicas").all() as ReplicaRow[];
}

export function touchReplicaHealth(id: number): void {
  health.touchHealth("replicas", id);
}

export function incrementUnhealthyTicks(id: number): number {
  return health.incrementUnhealthyTicks("replicas", id);
}

export function resetUnhealthyTicks(id: number): void {
  health.resetUnhealthyTicks("replicas", id);
}

export function insertMetricSample(sample: {
  replica_id: number;
  app_id: number;
  cpu_percent: number;
  memory_percent: number;
}): void {
  db.query(
    "INSERT INTO metrics_samples (replica_id, app_id, cpu_percent, memory_percent) VALUES (?, ?, ?, ?)"
  ).run(sample.replica_id, sample.app_id, sample.cpu_percent, sample.memory_percent);
}

export function getRecentAppMetrics(appId: number, sinceSeconds: number): Pick<MetricSampleRow, "replica_id" | "cpu_percent" | "memory_percent" | "sampled_at">[] {
  return db
    .query(
      `SELECT replica_id, cpu_percent, memory_percent, sampled_at
       FROM metrics_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(appId, `-${sinceSeconds} seconds`) as Pick<MetricSampleRow, "replica_id" | "cpu_percent" | "memory_percent" | "sampled_at">[];
}

export function getRecentMetricsByReplicas(replicaIds: number[], sinceSeconds: number): Pick<MetricSampleRow, "replica_id" | "cpu_percent" | "memory_percent" | "sampled_at">[] {
  if (replicaIds.length === 0) return [];
  const placeholders = replicaIds.map(() => "?").join(",");
  return db
    .query(
      `SELECT replica_id, cpu_percent, memory_percent, sampled_at
       FROM metrics_samples
       WHERE replica_id IN (${placeholders}) AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(...replicaIds, `-${sinceSeconds} seconds`) as Pick<MetricSampleRow, "replica_id" | "cpu_percent" | "memory_percent" | "sampled_at">[];
}

export function pruneOldMetrics(olderThanSeconds: number): void {
  db.query(
    "DELETE FROM metrics_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}

export function insertScalingEvent(event: {
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason?: string;
}): ScalingEventRow {
  return db
    .query(
      "INSERT INTO scaling_events (app_id, event_type, from_count, to_count, reason) VALUES (?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      event.app_id,
      event.event_type,
      event.from_count,
      event.to_count,
      event.reason || ""
    ) as ScalingEventRow;
}

export function getScalingEvents(appId: number, limit = 50): ScalingEventRow[] {
  return db
    .query("SELECT * FROM scaling_events WHERE app_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(appId, limit) as ScalingEventRow[];
}
