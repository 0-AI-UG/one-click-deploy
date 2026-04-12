import db from "./connection.ts";

export type EnvironmentRow = {
  id: number;
  name: string;
  env_vars: string;
  created_at: string;
};

export function getEnvironments(): EnvironmentRow[] {
  return db.query("SELECT * FROM environments ORDER BY name ASC").all() as EnvironmentRow[];
}

export function getEnvironment(id: number): EnvironmentRow | null {
  return db.query("SELECT * FROM environments WHERE id = ?").get(id) as EnvironmentRow | null;
}

export function insertEnvironment(name: string, envVars: string): EnvironmentRow {
  const result = db.query(
    "INSERT INTO environments (name, env_vars) VALUES (?, ?) RETURNING *"
  ).get(name, envVars) as EnvironmentRow;
  return result;
}

export function updateEnvironment(id: number, name: string, envVars: string): void {
  db.query("UPDATE environments SET name = ?, env_vars = ? WHERE id = ?").run(name, envVars, id);
}

export function deleteEnvironment(id: number): void {
  db.query("UPDATE apps SET environment_id = NULL WHERE environment_id = ?").run(id);
  db.query("DELETE FROM environments WHERE id = ?").run(id);
}
