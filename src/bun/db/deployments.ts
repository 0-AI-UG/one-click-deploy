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

export type DeployJobRow = {
  id: number;
  app_name: string;
  status: string;
  result_json: string;
  started_at: string;
  finished_at: string | null;
};

export type DeployJobEventRow = {
  job_id: number;
  seq: number;
  ts: string;
  step: string;
  detail: string;
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

export function getDeployments(appId: number): DeploymentRow[] {
  return db
    .query(
      "SELECT * FROM deployment_history WHERE app_id = ? ORDER BY created_at DESC"
    )
    .all(appId) as DeploymentRow[];
}

export function getDeployment(id: number): DeploymentRow | null {
  return db
    .query("SELECT * FROM deployment_history WHERE id = ?")
    .get(id) as DeploymentRow | null;
}

export function createDeployJob(appName: string): { id: number } {
  return db
    .query("INSERT INTO deploy_jobs (app_name) VALUES (?) RETURNING id")
    .get(appName) as { id: number };
}

export function appendDeployJobEvent(jobId: number, step: string, detail: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM deploy_job_events WHERE job_id = ?")
    .get(jobId) as { next: number };
  db.query(
    "INSERT INTO deploy_job_events (job_id, seq, step, detail) VALUES (?, ?, ?, ?)"
  ).run(jobId, row.next, step, detail);
  return row.next;
}

export function finishDeployJob(jobId: number, result: { ok: boolean; error?: string }): void {
  db.query(
    "UPDATE deploy_jobs SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(result.ok ? "done" : "error", JSON.stringify(result), jobId);
}

export function getDeployJob(id: number): DeployJobRow | null {
  return db.query("SELECT * FROM deploy_jobs WHERE id = ?").get(id) as DeployJobRow | null;
}

export function getDeployJobEvents(jobId: number, sinceSeq: number): Pick<DeployJobEventRow, "seq" | "ts" | "step" | "detail">[] {
  return db
    .query(
      "SELECT seq, ts, step, detail FROM deploy_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(jobId, sinceSeq) as Pick<DeployJobEventRow, "seq" | "ts" | "step" | "detail">[];
}
