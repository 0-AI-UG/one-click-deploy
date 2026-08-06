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
  webhook_owner_user_id: string;
  github_webhook_repo: string;
};

export type PanelDeploymentRow = {
  id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

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

export function updatePanelStatus(status: string): void {
  db.query("UPDATE panel SET status = ? WHERE id = 1").run(status);
}

export function updatePanelEnvVars(envVars: string): void {
  db.query("UPDATE panel SET env_vars = ? WHERE id = 1").run(envVars);
}

export function appendPanelDeployLog(line: string): void {
  db.query("UPDATE panel SET deploy_log = deploy_log || ? WHERE id = 1").run(line + "\n");
}

export function getPanelDeployLog(): string {
  const row = db.query("SELECT deploy_log FROM panel WHERE id = 1").get() as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function updatePanelWebhook(
  enabled: boolean,
  secret: string,
  githubWebhookId: string,
  ownerUserId?: string,
): void {
  db.query(
    `UPDATE panel SET webhook_enabled = ?, webhook_secret = ?, github_webhook_id = ?,
       webhook_owner_user_id = COALESCE(?, webhook_owner_user_id) WHERE id = 1`,
  ).run(enabled ? 1 : 0, secret, githubWebhookId, ownerUserId ?? null);
}

export function updatePanelWebhookProviderIdentity(repo: string, webhookId?: string): void {
  if (webhookId === undefined) {
    db.query("UPDATE panel SET github_webhook_repo = ? WHERE id = 1").run(repo);
  } else {
    db.query(
      "UPDATE panel SET github_webhook_repo = ?, github_webhook_id = ? WHERE id = 1",
    ).run(repo, webhookId);
  }
}

/** Clear provider identity only after the reconciler confirmed remote absence. */
export function finalizePanelWebhookDisabled(): void {
  db.query(
    `UPDATE panel SET webhook_secret = '', github_webhook_id = '',
       github_webhook_repo = '', webhook_owner_user_id = ''
     WHERE id = 1 AND webhook_enabled = 0`,
  ).run();
}

export function updatePanelDnsRecord(rec: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
}): void {
  db.query(
    "UPDATE panel SET dns_zone_id = ?, dns_name = ?, dns_type = ?, dns_value = ? WHERE id = 1",
  ).run(rec.zone_id, rec.name, rec.type, rec.value);
}

export function clearPanelDnsRecord(): void {
  db.query(
    "UPDATE panel SET dns_zone_id = '', dns_name = '', dns_type = '', dns_value = '' WHERE id = 1",
  ).run();
}

export function deletePanel(): void {
  db.query("DELETE FROM panel WHERE id = 1").run();
}

export function insertPanelDeployment(deployment: {
  image_tag: string;
  git_commit: string;
  status?: string;
  source?: string;
  deploy_log?: string;
}): PanelDeploymentRow {
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
    ) as PanelDeploymentRow;
}

export function getPanelDeployments(): PanelDeploymentRow[] {
  return db
    .query("SELECT * FROM panel_deployments ORDER BY created_at DESC LIMIT 50")
    .all() as PanelDeploymentRow[];
}
