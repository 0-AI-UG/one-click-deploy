import db from "./connection.ts";

export type BuildWorkerRow = {
  id: number;
  server_id: number;
  name: string;
  architecture: string;
  previous_pool: string;
  status: string;
  last_error: string;
  last_checked_at: string | null;
  worker_version: string;
  created_at: string;
};

export type BuildSourceRow = {
  id: number;
  repository: string;
  branch: string;
  worker_id: number;
  webhook_enabled: number;
  last_delivery_id: string;
  last_commit: string;
  last_status: string;
  last_error: string;
  last_received_at: string | null;
  created_at: string;
};

export function getBuildWorkers(): BuildWorkerRow[] {
  return db.query("SELECT * FROM build_workers ORDER BY created_at DESC").all() as BuildWorkerRow[];
}

export function getBuildWorker(id: number): BuildWorkerRow | null {
  return db.query("SELECT * FROM build_workers WHERE id = ?").get(id) as BuildWorkerRow | null;
}

export function getBuildWorkerByServerId(serverId: number): BuildWorkerRow | null {
  return db.query("SELECT * FROM build_workers WHERE server_id = ?").get(serverId) as BuildWorkerRow | null;
}

export function insertBuildWorker(input: { serverId: number; name: string; previousPool: string }): BuildWorkerRow {
  return db.query(
    `INSERT INTO build_workers (server_id, name, previous_pool, status)
     VALUES (?, ?, ?, 'installing') RETURNING *`,
  ).get(input.serverId, input.name, input.previousPool) as BuildWorkerRow;
}

export function updateBuildWorker(
  id: number,
  fields: Partial<Pick<BuildWorkerRow, "status" | "last_error" | "worker_version" | "architecture" | "last_checked_at">>,
): void {
  const clauses: string[] = [];
  const values: Array<string | null | number> = [];
  for (const [column, value] of Object.entries(fields)) {
    clauses.push(`${column} = ?`);
    values.push(value ?? null);
  }
  if (!clauses.length) return;
  values.push(id);
  db.query(`UPDATE build_workers SET ${clauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteBuildWorker(id: number): void {
  db.query("DELETE FROM build_workers WHERE id = ?").run(id);
}

export function getBuildSource(id: number): BuildSourceRow | null {
  return db.query("SELECT * FROM build_sources WHERE id = ?").get(id) as BuildSourceRow | null;
}

export function getBuildSourceByRepository(repository: string, branch: string): BuildSourceRow | null {
  return db.query("SELECT * FROM build_sources WHERE repository = ? AND branch = ?").get(repository, branch) as BuildSourceRow | null;
}

export function getBuildSources(): BuildSourceRow[] {
  return db.query("SELECT * FROM build_sources ORDER BY repository, branch").all() as BuildSourceRow[];
}

export function upsertBuildSource(input: { repository: string; branch: string; workerId: number; webhookEnabled?: boolean }): BuildSourceRow {
  return db.query(
    `INSERT INTO build_sources (repository, branch, worker_id, webhook_enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repository, branch) DO UPDATE SET
       worker_id = excluded.worker_id,
       webhook_enabled = excluded.webhook_enabled
     RETURNING *`,
  ).get(input.repository, input.branch, input.workerId, input.webhookEnabled === false ? 0 : 1) as BuildSourceRow;
}

export function updateBuildSourceDelivery(
  id: number,
  fields: Partial<Pick<BuildSourceRow, "last_delivery_id" | "last_commit" | "last_status" | "last_error" | "last_received_at">>,
): void {
  const clauses: string[] = [];
  const values: Array<string | null> = [];
  for (const [column, value] of Object.entries(fields)) {
    clauses.push(`${column} = ?`);
    values.push(value ?? null);
  }
  if (!clauses.length) return;
  values.push(String(id));
  db.query(`UPDATE build_sources SET ${clauses.join(", ")} WHERE id = ?`).run(...values);
}

export function appsForBuildSource(sourceId: number) {
  return db.query("SELECT * FROM apps WHERE build_source_id = ? ORDER BY id").all(sourceId);
}
