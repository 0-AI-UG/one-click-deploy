import db from "./connection.ts";

export type GitHubRunnerRow = {
  id: number;
  server_id: number;
  name: string;
  scope_url: string;
  labels: string;
  runner_version: string;
  architecture: string;
  previous_pool: string;
  status: string;
  last_error: string;
  last_checked_at: string | null;
  created_at: string;
};

export function getGitHubRunners(): GitHubRunnerRow[] {
  return db.query("SELECT * FROM github_runners ORDER BY created_at DESC").all() as GitHubRunnerRow[];
}

export function getGitHubRunner(id: number): GitHubRunnerRow | null {
  return db.query("SELECT * FROM github_runners WHERE id = ?").get(id) as GitHubRunnerRow | null;
}

export function getGitHubRunnerByServerId(serverId: number): GitHubRunnerRow | null {
  return db.query("SELECT * FROM github_runners WHERE server_id = ?").get(serverId) as GitHubRunnerRow | null;
}

export function insertGitHubRunner(input: {
  serverId: number;
  name: string;
  scopeUrl: string;
  previousPool: string;
}): GitHubRunnerRow {
  return db.query(
    `INSERT INTO github_runners (server_id, name, scope_url, previous_pool)
     VALUES (?, ?, ?, ?) RETURNING *`,
  ).get(input.serverId, input.name, input.scopeUrl, input.previousPool) as GitHubRunnerRow;
}

export function updateGitHubRunner(
  id: number,
  fields: Partial<Pick<GitHubRunnerRow, "status" | "last_error" | "runner_version" | "architecture" | "last_checked_at">>,
): void {
  const clauses: string[] = [];
  const values: Array<string | null | number> = [];
  for (const [column, value] of Object.entries(fields)) {
    clauses.push(`${column} = ?`);
    values.push(value ?? null);
  }
  if (clauses.length === 0) return;
  values.push(id);
  db.query(`UPDATE github_runners SET ${clauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteGitHubRunner(id: number): void {
  db.query("DELETE FROM github_runners WHERE id = ?").run(id);
}
