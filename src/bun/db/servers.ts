import db from "./connection.ts";

export type ServerState = "materialized" | "frozen";

export type ServerRow = {
  id: number;
  name: string;
  provider_id: string;
  provider: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  /** Lifecycle state — "materialized" (cloud instance exists) or "frozen"
   *  (snapshot-only parking state, provider_id/ipv4 cleared). */
  state: ServerState;
  /** Provider snapshot id when frozen, empty string otherwise. */
  snapshot_id: string;
  /** JSON-encoded array of provider volume IDs detached during freeze. Empty
   *  string when the server has no cloud volumes. */
  frozen_volume_ids: string;
  frozen_at: string | null;
  /** Last freeze attempt failure timestamp, for retry backoff. */
  freeze_failed_at: string | null;
  /** Private IPv4 on the shared `ocd-net` Hetzner network. Empty string until
   *  the reconciler attaches the server. Used by Caddy upstreams + internal
   *  DNS so traffic stays off the public NIC. */
  private_ipv4: string;
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
  provider?: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  private_ipv4?: string;
}): ServerRow {
  return db
    .query(
      "INSERT INTO servers (name, provider_id, provider, ipv4, ipv6, type, location, status, private_ipv4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      server.name,
      server.provider_id,
      server.provider ?? "hetzner",
      server.ipv4,
      server.ipv6,
      server.type,
      server.location,
      server.status,
      server.private_ipv4 ?? "",
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

/**
 * Mark a server as frozen: the provider instance has been destroyed, the
 * snapshot is available, and detached cloud volumes are listed in
 * `volumeIds`. Clears `provider_id` and `ipv4` so nothing tries to talk to
 * the dead instance, but keeps the row so the wake path can recreate it.
 */
export function markServerFrozen(
  id: number,
  fields: { snapshot_id: string; volume_ids: string[] },
): void {
  const frozenAt = new Date().toISOString();
  db.query(
    `UPDATE servers SET
       state = 'frozen',
       snapshot_id = ?,
       frozen_volume_ids = ?,
       frozen_at = ?,
       freeze_failed_at = NULL,
       provider_id = '',
       ipv4 = '',
       private_ipv4 = ''
     WHERE id = ?`,
  ).run(fields.snapshot_id, JSON.stringify(fields.volume_ids), frozenAt, id);
}

/**
 * Mark a server as materialized again after a wake-from-deep-sleep: store
 * the new provider_id / ipv4, clear the frozen pointers, but keep
 * `snapshot_id` around until the wake path confirms the server is healthy
 * and deletes the old snapshot.
 */
export function markServerMaterialized(
  id: number,
  fields: { provider_id: string; ipv4: string; ipv6?: string; private_ipv4?: string },
): void {
  db.query(
    `UPDATE servers SET
       state = 'materialized',
       provider_id = ?,
       ipv4 = ?,
       ipv6 = COALESCE(?, ipv6),
       private_ipv4 = COALESCE(?, private_ipv4),
       frozen_at = NULL,
       frozen_volume_ids = ''
     WHERE id = ?`,
  ).run(
    fields.provider_id,
    fields.ipv4,
    fields.ipv6 ?? null,
    fields.private_ipv4 ?? null,
    id,
  );
}

export function clearServerSnapshot(id: number): void {
  db.query("UPDATE servers SET snapshot_id = '' WHERE id = ?").run(id);
}

export function setFreezeFailed(id: number): void {
  db.query("UPDATE servers SET freeze_failed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

export function getFrozenVolumeIds(server: ServerRow): string[] {
  if (!server.frozen_volume_ids) return [];
  try {
    const parsed = JSON.parse(server.frozen_volume_ids);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
