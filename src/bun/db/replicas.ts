import db from "./connection.ts";

export function insertReplica(replica: {
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status?: string;
}) {
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
    ) as any;
}

export function getReplicas(appId: number) {
  return db
    .query("SELECT * FROM replicas WHERE app_id = ? ORDER BY created_at ASC")
    .all(appId) as any[];
}

export function getReplica(id: number) {
  return db.query("SELECT * FROM replicas WHERE id = ?").get(id) as any;
}

export function getReplicasByServer(serverId: number) {
  return db
    .query("SELECT * FROM replicas WHERE server_id = ?")
    .all(serverId) as any[];
}

export function updateReplicaStatus(id: number, status: string) {
  db.query("UPDATE replicas SET status = ? WHERE id = ?").run(status, id);
}

export function updateReplicaMetrics(id: number, cpuPercent: number, memoryPercent: number) {
  db.query(
    "UPDATE replicas SET cpu_percent = ?, memory_percent = ?, last_health_at = datetime('now') WHERE id = ?"
  ).run(cpuPercent, memoryPercent, id);
}

export function deleteReplica(id: number) {
  db.query("DELETE FROM replicas WHERE id = ?").run(id);
}

export function getAllReplicas() {
  return db.query("SELECT * FROM replicas").all() as any[];
}

export function touchReplicaHealth(id: number) {
  db.query("UPDATE replicas SET last_health_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementUnhealthyTicks(id: number): number {
  db.query("UPDATE replicas SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT unhealthy_ticks FROM replicas WHERE id = ?").get(id) as any;
  return row?.unhealthy_ticks ?? 0;
}

export function resetUnhealthyTicks(id: number) {
  db.query("UPDATE replicas SET unhealthy_ticks = 0 WHERE id = ?").run(id);
}

export function nextReplicaHostPort(serverId: number): number {
  const BASE_PORT = 10000;
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM replicas WHERE server_id = ?")
    .get(serverId) as any;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}

export function insertMetricSample(sample: {
  replica_id: number;
  app_id: number;
  cpu_percent: number;
  memory_percent: number;
}) {
  db.query(
    "INSERT INTO metrics_samples (replica_id, app_id, cpu_percent, memory_percent) VALUES (?, ?, ?, ?)"
  ).run(sample.replica_id, sample.app_id, sample.cpu_percent, sample.memory_percent);
}

export function getRecentAppMetrics(appId: number, sinceSeconds: number) {
  return db
    .query(
      `SELECT replica_id, cpu_percent, memory_percent, sampled_at
       FROM metrics_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(appId, `-${sinceSeconds} seconds`) as any[];
}

export function pruneOldMetrics(olderThanSeconds: number) {
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
}) {
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
    ) as any;
}

export function getScalingEvents(appId: number, limit = 50) {
  return db
    .query("SELECT * FROM scaling_events WHERE app_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(appId, limit) as any[];
}
