import db from "./connection.ts";
import { getReplicasByServer } from "./replicas.ts";
import { getApps } from "./apps.ts";
import { getPanel } from "./panel.ts";

export function getServers() {
  return db
    .query("SELECT * FROM servers ORDER BY created_at DESC")
    .all() as any[];
}

export function getServer(id: number) {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as any;
}

export function getServerByHetznerId(hetznerId: string) {
  return db
    .query("SELECT * FROM servers WHERE hetzner_id = ?")
    .get(hetznerId) as any;
}

export function insertServer(server: {
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
}) {
  return db
    .query(
      "INSERT INTO servers (name, hetzner_id, ipv4, ipv6, type, location, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      server.name,
      server.hetzner_id,
      server.ipv4,
      server.ipv6,
      server.type,
      server.location,
      server.status
    ) as any;
}

export function updateServerStatus(id: number, status: string) {
  db.query("UPDATE servers SET status = ? WHERE id = ?").run(status, id);
}

export function updateServer(id: number, fields: {
  hetzner_id?: string;
  ipv4?: string;
  ipv6?: string;
  status?: string;
}) {
  const setClauses: string[] = [];
  const values: any[] = [];
  if (fields.hetzner_id !== undefined) { setClauses.push("hetzner_id = ?"); values.push(fields.hetzner_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
  if (setClauses.length === 0) return;
  values.push(id);
  db.query(`UPDATE servers SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteServer(id: number) {
  db.query("DELETE FROM servers WHERE id = ?").run(id);
}

export function updateServerHostKey(id: number, hostKey: string) {
  db.query("UPDATE servers SET ssh_host_key = ? WHERE id = ?").run(hostKey, id);
}

export async function gcServerIfEmpty(serverId: number): Promise<void> {
  if (getReplicasByServer(serverId).length > 0) return;
  if (getApps(serverId).length > 0) return;
  if (getPanel()?.server_id === serverId) return;
  // Don't GC servers that host sleeping apps (scale-to-zero)
  const sleepingCount = (db.query("SELECT COUNT(*) as c FROM apps WHERE sleeping_server_id = ?").get(serverId) as any)?.c ?? 0;
  if (sleepingCount > 0) return;
  const server = getServer(serverId);
  if (!server) return;
  // Lazy import to avoid circular dependency between db.ts and hetzner/index.ts.
  const hetzner = await import("../hetzner/index.ts");
  if (server.hetzner_id) {
    try {
      await hetzner.deleteHetznerServer(server.hetzner_id);
    } catch (err) {
      console.error(`[db:gcServerIfEmpty] failed to delete hetzner server ${server.hetzner_id}:`, err);
    }
  }
  deleteServer(serverId);
}
