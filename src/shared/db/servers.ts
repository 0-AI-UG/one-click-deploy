import db from "./connection.ts";

export type ServerRow = {
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  /** Private IPv4 on the shared `ocd-net` Hetzner network. Empty string until
   *  the reconciler attaches the server. Used by ingress upstreams + internal
   *  DNS so traffic stays off the public NIC. */
  private_ipv4: string;
  /** Named capacity pool this server belongs to. 'general' is the default pool
   *  every server lands in; apps schedule onto servers whose pool matches their
   *  placement_pool. */
  pool: string;
  created_at: string;
};

export function getServers(): ServerRow[] {
  return db
    .query("SELECT * FROM servers ORDER BY created_at DESC")
    .all() as ServerRow[];
}

export function getServer(id: number): ServerRow | null {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
}

export function getServerByProviderId(providerId: string): ServerRow | null {
  return db
    .query("SELECT * FROM servers WHERE provider_id = ?")
    .get(providerId) as ServerRow | null;
}

export function insertServer(server: {
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  private_ipv4?: string;
  pool?: string;
}): ServerRow {
  return db
    .query(
      "INSERT INTO servers (name, provider_id, ipv4, ipv6, type, location, status, private_ipv4, pool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      server.name,
      server.provider_id,
      server.ipv4,
      server.ipv6,
      server.type,
      server.location,
      server.status,
      server.private_ipv4 ?? "",
      server.pool ?? "general",
    ) as ServerRow;
}

export function updateServerStatus(id: number, status: string): void {
  db.query("UPDATE servers SET status = ? WHERE id = ?").run(status, id);
}

export function updateServer(id: number, fields: {
  provider_id?: string;
  ipv4?: string;
  ipv6?: string;
  status?: string;
  private_ipv4?: string;
}): void {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];
  if (fields.provider_id !== undefined) { setClauses.push("provider_id = ?"); values.push(fields.provider_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
  if (fields.private_ipv4 !== undefined) { setClauses.push("private_ipv4 = ?"); values.push(fields.private_ipv4); }
  if (setClauses.length === 0) return;
  values.push(id);
  db.query(`UPDATE servers SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteServer(id: number): void {
  db.query("DELETE FROM servers WHERE id = ?").run(id);
}

export function updateServerHostKey(id: number, hostKey: string): void {
  db.query("UPDATE servers SET ssh_host_key = ? WHERE id = ?").run(hostKey, id);
}

/** Move a server into a named capacity pool. Apps schedule onto servers whose
 *  pool matches their placement_pool. */
export function updateServerPool(id: number, pool: string): void {
  db.query("UPDATE servers SET pool = ? WHERE id = ?").run(pool, id);
}

export function getServersByPool(pool: string): ServerRow[] {
  return db
    .query("SELECT * FROM servers WHERE pool = ? ORDER BY created_at DESC")
    .all(pool) as ServerRow[];
}

/** Distinct, non-empty capacity pools any server is currently assigned to. */
export function getDistinctServerPools(): string[] {
  return (db.query("SELECT DISTINCT pool FROM servers WHERE pool <> ''").all() as { pool: string }[])
    .map((r) => r.pool);
}

// --- Server-level metrics ---

export type ServerMetricSampleRow = {
  id: number;
  server_id: number;
  cpu_percent: number;
  memory_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  sampled_at: string;
};

export function insertServerMetricSample(
  serverId: number,
  cpuPercent: number,
  memPercent: number,
  diskUsedGb = 0,
  diskTotalGb = 0,
): void {
  db.query(
    "INSERT INTO server_metrics_samples (server_id, cpu_percent, memory_percent, disk_used_gb, disk_total_gb) VALUES (?, ?, ?, ?, ?)"
  ).run(serverId, cpuPercent, memPercent, diskUsedGb, diskTotalGb);
}

export function getRecentServerMetrics(sinceSeconds: number): Pick<ServerMetricSampleRow, "server_id" | "cpu_percent" | "memory_percent" | "disk_used_gb" | "disk_total_gb" | "sampled_at">[] {
  return db
    .query(
      `SELECT server_id, cpu_percent, memory_percent, disk_used_gb, disk_total_gb, sampled_at
       FROM server_metrics_samples
       WHERE sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(`-${sinceSeconds} seconds`) as Pick<ServerMetricSampleRow, "server_id" | "cpu_percent" | "memory_percent" | "disk_used_gb" | "disk_total_gb" | "sampled_at">[];
}

export function pruneOldServerMetrics(olderThanSeconds: number): void {
  db.query(
    "DELETE FROM server_metrics_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}
