import db from "./connection.ts";

export type EnvironmentRow = {
  id: number;
  org_id: string;
  name: string;
  env_vars: string;
  created_at: string;
};

export function getEnvironments(orgId: string): EnvironmentRow[] {
  return db.query("SELECT * FROM environments WHERE org_id = ? ORDER BY created_at").all(orgId) as EnvironmentRow[];
}

export function getEnvironment(id: number): EnvironmentRow | null {
  return db.query("SELECT * FROM environments WHERE id = ?").get(id) as EnvironmentRow | null;
}

export function insertEnvironment(name: string, envVars: string, orgId: string): EnvironmentRow {
  const result = db.query(
    "INSERT INTO environments (name, env_vars, org_id) VALUES (?, ?, ?) RETURNING *"
  ).get(name, envVars, orgId) as EnvironmentRow;
  return result;
}

export function updateEnvironment(id: number, name: string, envVars: string): void {
  db.query("UPDATE environments SET name = ?, env_vars = ? WHERE id = ?").run(name, envVars, id);
}

export function deleteEnvironment(id: number): void {
  db.query("DELETE FROM environments WHERE id = ?").run(id);
}
