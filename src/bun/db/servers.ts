import db from "./connection.ts";

export type ServerRow = {
  id: number;
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
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

export function getServerByHetznerId(hetznerId: string): ServerRow | null {
  return db
    .query("SELECT * FROM servers WHERE hetzner_id = ?")
    .get(hetznerId) as ServerRow | null;
}

export function insertServer(server: {
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
}): ServerRow {
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
    ) as ServerRow;
}

export function updateServerStatus(id: number, status: string): void {
  db.query("UPDATE servers SET status = ? WHERE id = ?").run(status, id);
}

export function updateServer(id: number, fields: {
  hetzner_id?: string;
  ipv4?: string;
  ipv6?: string;
  status?: string;
}): void {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];
  if (fields.hetzner_id !== undefined) { setClauses.push("hetzner_id = ?"); values.push(fields.hetzner_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
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
