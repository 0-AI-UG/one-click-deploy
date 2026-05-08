import db from "./connection.ts";

export type DeploymentRow = {
  id: number;
  app_id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

export function insertDeployment(deployment: {
  app_id: number;
  image_tag: string;
  git_commit: string;
  deploy_log?: string;
  status?: string;
  source?: string;
  created_at?: string;
}): DeploymentRow {
  const status = deployment.status ?? "deployed";
  const source = deployment.source ?? "manual";
  if (deployment.created_at) {
    return db
      .query(
        "INSERT INTO deployment_history (app_id, image_tag, git_commit, deploy_log, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
      )
      .get(
        deployment.app_id,
        deployment.image_tag,
        deployment.git_commit,
        deployment.deploy_log ?? "",
        status,
        source,
        deployment.created_at
      ) as DeploymentRow;
  }
  return db
    .query(
      "INSERT INTO deployment_history (app_id, image_tag, git_commit, deploy_log, status, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      deployment.app_id,
      deployment.image_tag,
      deployment.git_commit,
      deployment.deploy_log ?? "",
      status,
      source
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

export function getDeployments(appId: number, orgId: string): DeploymentRow[] {
  return db
    .query(
      "SELECT d.* FROM deployment_history d JOIN apps a ON a.id = d.app_id WHERE d.app_id = ? AND a.org_id = ? ORDER BY d.created_at DESC"
    )
    .all(appId, orgId) as DeploymentRow[];
}

export function getDeployment(id: number, orgId: string): DeploymentRow | null {
  return db
    .query(
      "SELECT d.* FROM deployment_history d JOIN apps a ON a.id = d.app_id WHERE d.id = ? AND a.org_id = ?"
    )
    .get(id, orgId) as DeploymentRow | null;
}

/** Engine-internal: look up a deployment by id without org scoping.
 * Use only in engine ops/reconciler where no request context is available.
 * Route handlers MUST use getDeployment(id, orgId) instead. */
export function getDeploymentUnscoped(id: number): DeploymentRow | null {
  return db
    .query("SELECT * FROM deployment_history WHERE id = ?")
    .get(id) as DeploymentRow | null;
}
