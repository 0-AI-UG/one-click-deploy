import db from "./connection.ts";
import { nextReplicaHostPort } from "./replicas.ts";

export function getApps(serverId?: number) {
  if (serverId) {
    return db
      .query(
        "SELECT DISTINCT a.* FROM apps a JOIN replicas r ON r.app_id = a.id WHERE r.server_id = ? ORDER BY a.created_at DESC"
      )
      .all(serverId) as any[];
  }
  return db
    .query("SELECT * FROM apps ORDER BY created_at DESC")
    .all() as any[];
}

export function getApp(id: number) {
  return db.query("SELECT * FROM apps WHERE id = ?").get(id) as any;
}

export function getAppByName(name: string) {
  return db.query("SELECT * FROM apps WHERE name = ?").get(name) as any;
}

export function renameApp(id: number, newName: string) {
  db.query("UPDATE apps SET name = ? WHERE id = ?").run(newName, id);
  db.query("UPDATE replicas SET container_name = ? WHERE app_id = ?").run(newName, id);
}

export function insertApp(app: {
  name: string;
  domain: string;
  git_repo: string;
  dockerfile_path: string;
  container_port: number;
  env_vars: string;
  auth_password?: string;
}) {
  return db
    .query(
      "INSERT INTO apps (name, domain, git_repo, dockerfile_path, container_port, env_vars, auth_password) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      app.name,
      app.domain,
      app.git_repo,
      app.dockerfile_path,
      app.container_port,
      app.env_vars,
      app.auth_password || ""
    ) as any;
}

export function insertAppWithFirstReplica(
  app: {
    name: string;
    domain: string;
    git_repo: string;
    dockerfile_path: string;
    container_port: number;
    env_vars: string;
    auth_password?: string;
  },
  serverId: number,
): { app: any; replica: any } {
  const tx = db.transaction(() => {
    const appRow = db
      .query(
        "INSERT INTO apps (name, domain, git_repo, dockerfile_path, container_port, env_vars, auth_password) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        app.name,
        app.domain,
        app.git_repo,
        app.dockerfile_path,
        app.container_port,
        app.env_vars,
        app.auth_password || "",
      ) as any;
    const hostPort = nextReplicaHostPort(serverId);
    const replicaRow = db
      .query(
        "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(appRow.id, serverId, hostPort, app.name, "deploying") as any;
    return { app: appRow, replica: replicaRow };
  });
  return tx();
}

export function getServersForApp(appId: number): any[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as any[];
}

export function updateAppStatus(id: number, status: string) {
  db.query("UPDATE apps SET status = ? WHERE id = ?").run(status, id);
}

export function updateAppSleepingState(id: number, serverId: number, hostPort: number, wakeToken: string) {
  db.query("UPDATE apps SET sleeping_server_id = ?, sleeping_host_port = ?, wake_token = ? WHERE id = ?").run(serverId, hostPort, wakeToken, id);
}

export function clearAppSleepingState(id: number) {
  db.query("UPDATE apps SET sleeping_server_id = NULL, sleeping_host_port = NULL, wake_token = NULL WHERE id = ?").run(id);
}

export function updateAppDeployedBy(id: number, userId: string) {
  db.query("UPDATE apps SET deployed_by = ? WHERE id = ?").run(userId, id);
}

export function appendDeployLog(id: number, line: string) {
  db.query(
    "UPDATE apps SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function getDeployLog(id: number): string {
  const row = db
    .query("SELECT deploy_log FROM apps WHERE id = ?")
    .get(id) as any;
  return row?.deploy_log ?? "";
}

export function deleteApp(id: number) {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

export function updateAppEnvVars(id: number, envVars: string) {
  db.query("UPDATE apps SET env_vars = ? WHERE id = ?").run(envVars, id);
}

export function updateAppContainerPort(id: number, port: number) {
  db.query("UPDATE apps SET container_port = ? WHERE id = ?").run(port, id);
}

export function updateAppDomain(id: number, domain: string) {
  db.query("UPDATE apps SET domain = ? WHERE id = ?").run(domain, id);
}

export function updateAppVolume(id: number, volumeId: string, volumeMount: string) {
  db.query("UPDATE apps SET volume_id = ?, volume_mount = ? WHERE id = ?").run(volumeId, volumeMount, id);
}

export function updateAppAuthPassword(id: number, authPassword: string) {
  db.query("UPDATE apps SET auth_password = ? WHERE id = ?").run(authPassword, id);
}

export function updateAppDeployMode(
  id: number,
  deployMode: string,
  composeFile: string,
  composeWebService: string
) {
  db.query(
    "UPDATE apps SET deploy_mode = ?, compose_file = ?, compose_web_service = ? WHERE id = ?"
  ).run(deployMode, composeFile, composeWebService, id);
}

export function updateAppWebhook(
  id: number,
  enabled: boolean,
  secret: string,
  branch: string,
  githubWebhookId: string,
  path: string = ""
) {
  db.query(
    "UPDATE apps SET webhook_enabled = ?, webhook_secret = ?, webhook_branch = ?, webhook_path = ?, github_webhook_id = ? WHERE id = ?"
  ).run(enabled ? 1 : 0, secret, branch, path, githubWebhookId, id);
}

export function updateAppScaling(id: number, fields: {
  desired_replicas?: number;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_enabled?: boolean;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  scale_to_zero_after?: number;
  last_scale_at?: string;
  hetzner_lb_id?: string;
}) {
  const sets: string[] = [];
  const values: any[] = [];
  if (fields.desired_replicas !== undefined) { sets.push("desired_replicas = ?"); values.push(fields.desired_replicas); }
  if (fields.min_replicas !== undefined) { sets.push("min_replicas = ?"); values.push(fields.min_replicas); }
  if (fields.max_replicas !== undefined) { sets.push("max_replicas = ?"); values.push(fields.max_replicas); }
  if (fields.autoscale_enabled !== undefined) { sets.push("autoscale_enabled = ?"); values.push(fields.autoscale_enabled ? 1 : 0); }
  if (fields.autoscale_cpu_threshold !== undefined) { sets.push("autoscale_cpu_threshold = ?"); values.push(fields.autoscale_cpu_threshold); }
  if (fields.autoscale_mem_threshold !== undefined) { sets.push("autoscale_mem_threshold = ?"); values.push(fields.autoscale_mem_threshold); }
  if (fields.autoscale_cooldown !== undefined) { sets.push("autoscale_cooldown = ?"); values.push(fields.autoscale_cooldown); }
  if (fields.scale_to_zero_after !== undefined) { sets.push("scale_to_zero_after = ?"); values.push(fields.scale_to_zero_after); }
  if (fields.last_scale_at !== undefined) { sets.push("last_scale_at = ?"); values.push(fields.last_scale_at); }
  if (fields.hetzner_lb_id !== undefined) { sets.push("hetzner_lb_id = ?"); values.push(fields.hetzner_lb_id); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function insertDnsRecord(record: {
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
}) {
  return db
    .query(
      "INSERT INTO dns_records (app_id, zone_id, record_id, name, type, value) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      record.app_id,
      record.zone_id,
      record.record_id,
      record.name,
      record.type,
      record.value
    ) as any;
}

export function getDnsRecords(appId: number) {
  return db
    .query("SELECT * FROM dns_records WHERE app_id = ?")
    .all(appId) as any[];
}

export function deleteDnsRecord(recordId: string) {
  db.query("DELETE FROM dns_records WHERE record_id = ?").run(recordId);
}
