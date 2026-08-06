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
  created_at?: string;
}): DeploymentRow {
  const status = deployment.status ?? "deployed";
  const source = deployment.source ?? "manual";
  if (deployment.created_at) {
    return db
      .query(
        "INSERT INTO deployment_history (app_id, image_tag, image_digest, env_hash, git_commit, deploy_log, status, source, config_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
      )
      .get(
        deployment.app_id,
        deployment.image_tag,
        deployment.image_digest ?? "",
        deployment.env_hash ?? "",
        deployment.git_commit,
        deployment.deploy_log ?? "",
        status,
        source,
        deployment.config_revision ?? 1,
        deployment.created_at
      ) as DeploymentRow;
  }
  return db
    .query(
      "INSERT INTO deployment_history (app_id, image_tag, image_digest, env_hash, git_commit, deploy_log, status, source, config_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      deployment.app_id,
      deployment.image_tag,
      deployment.image_digest ?? "",
      deployment.env_hash ?? "",
      deployment.git_commit,
      deployment.deploy_log ?? "",
      status,
      source,
      deployment.config_revision ?? 1
    ) as DeploymentRow;
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
  return getDeployments(appId).find((d) => d.status === "deployed")?.git_commit ?? null;
}

export function getDeployment(id: number): DeploymentRow | null {
  return db
    .query("SELECT * FROM deployment_history WHERE id = ?")
    .get(id) as DeploymentRow | null;
}
