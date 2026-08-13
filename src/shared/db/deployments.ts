import db from "./connection.ts";

export type DeploymentRow = {
  id: number;
  app_id: number;
  image_tag: string;
  image_digest: string;
  env_hash: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  config_revision: number;
  image_size_bytes: number;
  archive_size_bytes: number;
  transfer_size_bytes: number;
  operation_id: number | null;
  created_at: string;
};

export function insertDeployment(deployment: {
  app_id: number;
  image_tag: string;
  image_digest?: string;
  env_hash?: string;
  git_commit: string;
  deploy_log?: string;
  status?: string;
  source?: string;
  config_revision?: number;
  image_size_bytes?: number;
  archive_size_bytes?: number;
  transfer_size_bytes?: number;
  /** Durable operation identity. Re-entering a history step returns the row
   * created by its first attempt instead of adding a duplicate audit entry. */
  operation_id?: number;
  created_at?: string;
}): DeploymentRow {
  const status = deployment.status ?? "deployed";
  const source = deployment.source ?? "manual";
  const insert = (withCreatedAt: boolean): DeploymentRow => {
    const columns =
      "app_id, image_tag, image_digest, env_hash, git_commit, deploy_log, status, source, " +
      "config_revision, image_size_bytes, archive_size_bytes, transfer_size_bytes, operation_id" +
      (withCreatedAt ? ", created_at" : "");
    const placeholders = withCreatedAt
      ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
      : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
    const conflict = deployment.operation_id != null
      ? " ON CONFLICT(operation_id) WHERE operation_id IS NOT NULL DO UPDATE SET operation_id = excluded.operation_id"
      : "";
    const args: Array<string | number | null> = [
      deployment.app_id,
      deployment.image_tag,
      deployment.image_digest ?? "",
      deployment.env_hash ?? "",
      deployment.git_commit,
      deployment.deploy_log ?? "",
      status,
      source,
      deployment.config_revision ?? 1,
      deployment.image_size_bytes ?? 0,
      deployment.archive_size_bytes ?? 0,
      deployment.transfer_size_bytes ?? 0,
      deployment.operation_id ?? null,
    ];
    if (withCreatedAt) args.push(deployment.created_at!);
    return db
      .query(`INSERT INTO deployment_history (${columns}) VALUES (${placeholders})${conflict} RETURNING *`)
      .get(...args) as DeploymentRow;
  };
  return insert(!!deployment.created_at);
}

export function updateDeploymentStorage(id: number, storage: {
  image_size_bytes?: number;
  archive_size_bytes?: number;
  transfer_size_bytes?: number;
}): void {
  db.query(
    `UPDATE deployment_history SET
       image_size_bytes = COALESCE(?, image_size_bytes),
       archive_size_bytes = COALESCE(?, archive_size_bytes),
       transfer_size_bytes = COALESCE(?, transfer_size_bytes)
     WHERE id = ?`,
  ).run(
    storage.image_size_bytes ?? null,
    storage.archive_size_bytes ?? null,
    storage.transfer_size_bytes ?? null,
    id,
  );
}

export function updateDeploymentStatus(id: number, status: string): void {
  db.query("UPDATE deployment_history SET status = ? WHERE id = ?").run(status, id);
}

export function appendDeploymentLog(id: number, line: string): void {
  db.query(
    "UPDATE deployment_history SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function updateDeploymentGitCommit(id: number, gitCommit: string): void {
  db.query("UPDATE deployment_history SET git_commit = ? WHERE id = ?").run(gitCommit, id);
}

export function updateDeploymentConfigRevision(id: number, configRevision: number): void {
  db.query("UPDATE deployment_history SET config_revision = ? WHERE id = ?").run(configRevision, id);
}

export function getDeployments(appId: number): DeploymentRow[] {
  return db
    .query(
      "SELECT * FROM deployment_history WHERE app_id = ? ORDER BY created_at DESC, id DESC"
    )
    .all(appId) as DeploymentRow[];
}

/** The git commit an app is currently running, i.e. its most recent successful
 *  deployment — or null if it has never deployed successfully. This is the
 *  definition of "has something to promote", so promote paths share it rather
 *  than each re-deriving it. */
export function getDeployedCommit(appId: number): string | null {
  return getLastSuccessfulDeployment(appId)?.git_commit ?? null;
}

export function getLastSuccessfulDeployment(appId: number): DeploymentRow | null {
  return db.query(
    `SELECT * FROM deployment_history
     WHERE app_id = ? AND status = 'deployed'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(appId) as DeploymentRow | null;
}

/** Deployment history stores abbreviated SHAs; compare only valid SHA prefixes. */
export function gitCommitsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(a) || !/^[a-f0-9]{7,40}$/.test(b)) return a === b;
  return a.startsWith(b) || b.startsWith(a);
}

export function getDeployment(id: number): DeploymentRow | null {
  return db
    .query("SELECT * FROM deployment_history WHERE id = ?")
    .get(id) as DeploymentRow | null;
}
