import db from "./connection.ts";

export type PanelRow = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  git_repo: string;
  git_branch: string;
  container_port: number;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
  dns_zone_id: string;
  dns_name: string;
  dns_type: string;
  dns_value: string;
  webhook_secret: string;
  webhook_enabled: number;
  github_webhook_id: string;
};

export function updatePanelWebhook(
  enabled: boolean,
  secret: string,
  githubWebhookId: string,
) {
  db.query(
    "UPDATE panel SET webhook_enabled = ?, webhook_secret = ?, github_webhook_id = ? WHERE id = 1",
  ).run(enabled ? 1 : 0, secret, githubWebhookId);
}

export function updatePanelDnsRecord(rec: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
}) {
  db.query(
    "UPDATE panel SET dns_zone_id = ?, dns_name = ?, dns_type = ?, dns_value = ? WHERE id = 1",
  ).run(rec.zone_id, rec.name, rec.type, rec.value);
}

export function deletePanel() {
  db.query("DELETE FROM panel WHERE id = 1").run();
}

export function getPanel(): PanelRow | null {
  return (db.query("SELECT * FROM panel WHERE id = 1").get() as PanelRow) || null;
}

export function insertPanel(panel: {
  server_id: number;
  name: string;
  domain: string;
  git_repo: string;
  git_branch?: string;
  container_port: number;
  host_port: number;
  volume_id?: string;
  volume_mount?: string;
  env_vars?: string;
  status?: string;
}): PanelRow {
  return db
    .query(
      "INSERT INTO panel (id, server_id, name, domain, git_repo, git_branch, container_port, host_port, volume_id, volume_mount, env_vars, status) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      panel.server_id,
      panel.name,
      panel.domain,
      panel.git_repo,
      panel.git_branch ?? "main",
      panel.container_port,
      panel.host_port,
      panel.volume_id ?? "",
      panel.volume_mount ?? "",
      panel.env_vars ?? "{}",
      panel.status ?? "running",
    ) as PanelRow;
}

export function updatePanelStatus(status: string) {
  db.query("UPDATE panel SET status = ? WHERE id = 1").run(status);
}

export function updatePanelEnvVars(envVars: string) {
  db.query("UPDATE panel SET env_vars = ? WHERE id = 1").run(envVars);
}

export function appendPanelDeployLog(line: string) {
  db.query("UPDATE panel SET deploy_log = deploy_log || ? WHERE id = 1").run(line + "\n");
}

export function getPanelDeployLog(): string {
  const row = db.query("SELECT deploy_log FROM panel WHERE id = 1").get() as any;
  return row?.deploy_log ?? "";
}

export function insertPanelDeployment(deployment: {
  image_tag: string;
  git_commit: string;
  status?: string;
  source?: string;
  deploy_log?: string;
}) {
  return db
    .query(
      "INSERT INTO panel_deployments (image_tag, git_commit, status, source, deploy_log) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      deployment.image_tag,
      deployment.git_commit,
      deployment.status ?? "deployed",
      deployment.source ?? "manual",
      deployment.deploy_log ?? "",
    ) as any;
}

export function getPanelDeployments() {
  return db
    .query("SELECT * FROM panel_deployments ORDER BY created_at DESC LIMIT 50")
    .all() as any[];
}
