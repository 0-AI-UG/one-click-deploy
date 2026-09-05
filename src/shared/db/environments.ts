import db from "./connection.ts";
import { InjectedEnvVarError, parseEnvVars } from "../env-crypto.ts";

export type EnvironmentRow = {
  id: number;
  name: string;
  env_vars: string;
  created_at: string;
  deleted_at: string | null;
  purge_after: string | null;
};

export function getEnvironments(): EnvironmentRow[] {
  return db.query("SELECT * FROM environments WHERE deleted_at IS NULL ORDER BY name ASC").all() as EnvironmentRow[];
}

export function getEnvironment(id: number): EnvironmentRow | null {
  return db.query("SELECT * FROM environments WHERE id = ? AND deleted_at IS NULL").get(id) as EnvironmentRow | null;
}

export function getDeletedEnvironments(): EnvironmentRow[] {
  return db.query(
    "SELECT * FROM environments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
  ).all() as EnvironmentRow[];
}

export function getDeletedEnvironment(id: number): EnvironmentRow | null {
  return db.query(
    "SELECT * FROM environments WHERE id = ? AND deleted_at IS NOT NULL",
  ).get(id) as EnvironmentRow | null;
}

export function insertEnvironment(name: string, envVars: string): EnvironmentRow {
  const result = db.query(
    "INSERT INTO environments (name, env_vars) VALUES (?, ?) RETURNING *"
  ).get(name, envVars) as EnvironmentRow;
  return result;
}

export function updateEnvironment(id: number, name: string, envVars: string, options: { injection?: boolean } = {}): void {
  if (!options.injection) {
    const previous = getEnvironment(id) ?? getDeletedEnvironment(id);
    const incoming = parseEnvVars(envVars).entries;
    for (const entry of parseEnvVars(previous?.env_vars).entries) {
      if (!entry.injected_by) continue;
      const matches = incoming.filter((candidate) => candidate.key === entry.key);
      if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(entry)) {
        throw new InjectedEnvVarError(`${entry.key} is injected by ${entry.injected_by} and is read-only`);
      }
    }
  }
  db.query("UPDATE environments SET name = ?, env_vars = ? WHERE id = ?").run(name, envVars, id);
}

export function deleteEnvironment(id: number): void {
  db.query("DELETE FROM environments WHERE id = ?").run(id);
}

export function softDeleteEnvironment(id: number): void {
  db.query(
    `UPDATE environments
     SET deleted_at = datetime('now'), purge_after = datetime('now', '+7 days')
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(id);
}

export function restoreEnvironment(id: number): void {
  db.query(
    "UPDATE environments SET deleted_at = NULL, purge_after = NULL WHERE id = ? AND deleted_at IS NOT NULL",
  ).run(id);
}

export function isEnvironmentPurgeProtected(
  environment: Pick<EnvironmentRow, "purge_after">,
  now = Date.now(),
): boolean {
  if (!environment.purge_after) return false;
  const purgeAt = Date.parse(`${environment.purge_after.replace(" ", "T")}Z`);
  return Number.isFinite(purgeAt) && now < purgeAt;
}

/** Clone an environment under a new name. The stored env_vars blob (including
 *  encrypted secret ciphertext) is copied verbatim server-side — secrets are
 *  never round-tripped through the client to be duplicated. */
export function duplicateEnvironment(id: number, newName: string): EnvironmentRow {
  const src = getEnvironment(id);
  if (!src) throw new Error("Environment not found");
  return insertEnvironment(newName, src.env_vars);
}
