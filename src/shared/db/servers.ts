import db from "./connection.ts";

// Keep older engines compatible with the renamed routing-address schema.
const serverReadColumns = (db.query("PRAGMA table_info(servers)").all() as Array<{ name: string }>).some(column => column.name === "routing_address") ? "*, routing_address AS private_ipv4" : "*";

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
  /** Private IPv4 used for fleet routing. Managed Hetzner hosts receive it
   *  from `ocd-net`; connected hosts must supply an RFC1918 address that the
   *  panel verifies before enrollment. */
  private_ipv4: string;
  provider: "hetzner" | "external";
  ownership: "managed" | "connected";
  management_address: string;
  ssh_user: string;
  ssh_port: number;
  /** Named capacity pool this server belongs to. 'general' is the default pool
   *  every server lands in; apps schedule onto servers whose pool matches their
   *  placement_pool. */
  pool: string;
  provider_status: string;
  last_observed_at: string | null;
  unavailable_ticks: number;
  gc_requested_at: string | null;
  created_at: string;
};

export function getServers(): ServerRow[] {
  return db
    .query(`SELECT ${serverReadColumns} FROM servers ORDER BY created_at DESC`)
    .all() as ServerRow[];
}

export function getServer(id: number): ServerRow | null {
  return db.query(`SELECT ${serverReadColumns} FROM servers WHERE id = ?`).get(id) as ServerRow | null;
}

export function getServerByProviderId(providerId: string): ServerRow | null {
  return db
    .query(`SELECT ${serverReadColumns} FROM servers WHERE provider_id = ?`)
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
  provider?: "hetzner" | "external";
  ownership?: "managed" | "connected";
  management_address?: string;
  ssh_user?: string;
  ssh_port?: number;
}): ServerRow {
  return db
    .query(
      "INSERT INTO servers (name, provider_id, ipv4, ipv6, type, location, status, private_ipv4, pool, provider, ownership, management_address, ssh_user, ssh_port) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
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
      server.provider ?? "external",
      server.ownership ?? "connected",
      server.management_address ?? server.ipv4,
      server.ssh_user ?? "root",
      server.ssh_port ?? 22,
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
  management_address?: string;
  ssh_user?: string;
  ssh_port?: number;
}): void {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];
  if (fields.provider_id !== undefined) { setClauses.push("provider_id = ?"); values.push(fields.provider_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
  if (fields.private_ipv4 !== undefined) { setClauses.push("private_ipv4 = ?"); values.push(fields.private_ipv4); }
  if (fields.management_address !== undefined) { setClauses.push("management_address = ?"); values.push(fields.management_address); }
  if (fields.ssh_user !== undefined) { setClauses.push("ssh_user = ?"); values.push(fields.ssh_user); }
  if (fields.ssh_port !== undefined) { setClauses.push("ssh_port = ?"); values.push(fields.ssh_port); }
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

export function recordServerObservation(
  id: number,
  observation: {
    providerStatus: string;
    ipv4?: string;
    ipv6?: string;
    privateIpv4?: string;
    available: boolean;
  },
): void {
  db.query(
    `UPDATE servers
       SET provider_status = ?, last_observed_at = datetime('now'),
           unavailable_ticks = CASE WHEN ? THEN 0 ELSE unavailable_ticks + 1 END,
           ipv4 = COALESCE(?, ipv4), ipv6 = COALESCE(?, ipv6),
           private_ipv4 = COALESCE(?, private_ipv4)
     WHERE id = ?`,
  ).run(
    observation.providerStatus,
    observation.available ? 1 : 0,
    observation.ipv4 ?? null,
    observation.ipv6 ?? null,
    observation.privateIpv4 ?? null,
    id,
  );
}

export function requestServerGc(id: number): void {
  db.query("UPDATE servers SET gc_requested_at = COALESCE(gc_requested_at, datetime('now')) WHERE id = ?").run(id);
}

export function clearServerGcRequest(id: number): void {
  db.query("UPDATE servers SET gc_requested_at = NULL WHERE id = ?").run(id);
}

export function getServersByPool(pool: string): ServerRow[] {
  return db
    .query(`SELECT ${serverReadColumns} FROM servers WHERE pool = ? ORDER BY created_at DESC`)
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
