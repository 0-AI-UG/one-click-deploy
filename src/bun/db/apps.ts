import db from "./connection.ts";
import type { ServerRow } from "./servers.ts";
import type { ReplicaRow } from "./replicas.ts";

export type AppRow = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  dockerfile_path: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
  volume_id: string;
  volume_mount: string;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  webhook_path: string;
  github_webhook_id: string;
  auth_password: string;
  deploy_mode: string;
  compose_file: string;
  compose_web_service: string;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  last_scale_at: string | null;
  deployed_by: string;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  scale_to_zero_after: number;
  wake_token: string | null;
};

export type DnsRecordRow = {
  id: number;
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
};

export function getApps(serverId?: number): AppRow[] {
  if (serverId) {
    return db
      .query(
        "SELECT DISTINCT a.* FROM apps a JOIN replicas r ON r.app_id = a.id WHERE r.server_id = ? ORDER BY a.created_at DESC"
      )
      .all(serverId) as AppRow[];
  }
  return db
    .query("SELECT * FROM apps ORDER BY created_at DESC")
    .all() as AppRow[];
}

export function getApp(id: number): AppRow | null {
  return db.query("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | null;
}

export function getAppByName(name: string): AppRow | null {
  return db.query("SELECT * FROM apps WHERE name = ?").get(name) as AppRow | null;
}

export function getAppByDomain(domain: string): AppRow | null {
  return db
    .query("SELECT * FROM apps WHERE domain = ? LIMIT 1")
    .get(domain) as AppRow | null;
}

export function renameApp(id: number, newName: string): void {
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
}): AppRow {
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
    ) as AppRow;
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
): { app: AppRow; replica: ReplicaRow } {
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
      ) as AppRow;
    const hostPort = nextReplicaHostPort(serverId);
    const replicaRow = db
      .query(
        "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(appRow.id, serverId, hostPort, app.name, "deploying") as ReplicaRow;
    return { app: appRow, replica: replicaRow };
  });
  return tx();
}

export function getServersForApp(appId: number): ServerRow[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as ServerRow[];
}

/**
 * Returns true iff the server has at least one running (non-stopped) replica.
 * A replica row with status = 'stopped' is a light-sleep anchor, not a
 * running tenant — such servers are still materialized on the provider but
 * are doing no work.
 */
export function hasRunningReplicas(serverId: number): boolean {
  const row = db
    .query("SELECT COUNT(*) as c FROM replicas WHERE server_id = ? AND status != 'stopped'")
    .get(serverId) as { c: number } | null;
  return (row?.c ?? 0) > 0;
}

/**
 * Returns true iff the server has at least one replica row (of any status).
 * A server with only stopped replicas anchors the light-sleep state and must
 * survive gc — those rows are how wake knows where to `docker start`.
 */
export function hasAnyReplicas(serverId: number): boolean {
  const row = db
    .query("SELECT COUNT(*) as c FROM replicas WHERE server_id = ?")
    .get(serverId) as { c: number } | null;
  return (row?.c ?? 0) > 0;
}

export async function gcServerIfEmpty(serverId: number): Promise<void> {
  // A server is gc-eligible iff it has *zero* replica rows. Stopped replicas
  // (light-sleep anchors) count as "present" — those servers stay
  // materialized so the next wake is a `docker start` away.
  if (hasAnyReplicas(serverId)) return;
  if (getApps(serverId).length > 0) return;
  const { getPanel } = await import("./panel.ts");
  if (getPanel()?.server_id === serverId) return;
  const sleepingRow = db.query("SELECT COUNT(*) as c FROM apps WHERE sleeping_server_id = ?").get(serverId) as { c: number } | null;
  const sleepingCount = sleepingRow?.c ?? 0;
  if (sleepingCount > 0) return;
  const { getServer, deleteServer } = await import("./servers.ts");
  const server = getServer(serverId);
  if (!server) return;
  const { getComputeProvider } = await import("../providers/index.ts");
  let compute;
  try {
    compute = getComputeProvider(server.provider);
  } catch {
    compute = undefined;
  }
  if (server.provider_id && compute) {
    try {
      await compute.deleteServer(server.provider_id);
    } catch (err) {
      console.error(
        `[db:gcServerIfEmpty] failed to delete server ${server.provider_id} (${server.provider}):`,
        err,
      );
    }
  }
  deleteServer(serverId);
}

export function updateAppStatus(id: number, status: string): void {
  db.query("UPDATE apps SET status = ? WHERE id = ?").run(status, id);
}

export function updateAppSleepingState(id: number, serverId: number, hostPort: number, wakeToken: string): void {
  db.query("UPDATE apps SET sleeping_server_id = ?, sleeping_host_port = ?, wake_token = ? WHERE id = ?").run(serverId, hostPort, wakeToken, id);
}

export function clearAppSleepingState(id: number): void {
  db.query("UPDATE apps SET sleeping_server_id = NULL, sleeping_host_port = NULL, wake_token = NULL WHERE id = ?").run(id);
}

export function updateAppDeployedBy(id: number, userId: string): void {
  db.query("UPDATE apps SET deployed_by = ? WHERE id = ?").run(userId, id);
}

export function appendDeployLog(id: number, line: string): void {
  db.query(
    "UPDATE apps SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function getDeployLog(id: number): string {
  const row = db
    .query("SELECT deploy_log FROM apps WHERE id = ?")
    .get(id) as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deleteApp(id: number): void {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

export function insertDnsRecord(record: {
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
}): DnsRecordRow {
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
    ) as DnsRecordRow;
}

export function getDnsRecords(appId: number): DnsRecordRow[] {
  return db
    .query("SELECT * FROM dns_records WHERE app_id = ?")
    .all(appId) as DnsRecordRow[];
}

export function deleteDnsRecord(recordId: string): void {
  db.query("DELETE FROM dns_records WHERE record_id = ?").run(recordId);
}

export function updateAppEnvVars(id: number, envVars: string): void {
  db.query("UPDATE apps SET env_vars = ? WHERE id = ?").run(envVars, id);
}

export function updateAppContainerPort(id: number, port: number): void {
  db.query("UPDATE apps SET container_port = ? WHERE id = ?").run(port, id);
}

export function updateAppDomain(id: number, domain: string): void {
  db.query("UPDATE apps SET domain = ? WHERE id = ?").run(domain, id);
}

export function updateAppVolume(id: number, volumeId: string, volumeMount: string): void {
  db.query("UPDATE apps SET volume_id = ?, volume_mount = ? WHERE id = ?").run(volumeId, volumeMount, id);
}

export function updateAppAuthPassword(id: number, authPassword: string): void {
  db.query("UPDATE apps SET auth_password = ? WHERE id = ?").run(authPassword, id);
}

export function updateAppDeployMode(
  id: number,
  deployMode: string,
  composeFile: string,
  composeWebService: string
): void {
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
): void {
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
}): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (fields.desired_replicas !== undefined) { sets.push("desired_replicas = ?"); values.push(fields.desired_replicas); }
  if (fields.min_replicas !== undefined) { sets.push("min_replicas = ?"); values.push(fields.min_replicas); }
  if (fields.max_replicas !== undefined) { sets.push("max_replicas = ?"); values.push(fields.max_replicas); }
  if (fields.autoscale_enabled !== undefined) { sets.push("autoscale_enabled = ?"); values.push(fields.autoscale_enabled ? 1 : 0); }
  if (fields.autoscale_cpu_threshold !== undefined) { sets.push("autoscale_cpu_threshold = ?"); values.push(fields.autoscale_cpu_threshold); }
  if (fields.autoscale_mem_threshold !== undefined) { sets.push("autoscale_mem_threshold = ?"); values.push(fields.autoscale_mem_threshold); }
  if (fields.autoscale_cooldown !== undefined) { sets.push("autoscale_cooldown = ?"); values.push(fields.autoscale_cooldown); }
  if (fields.scale_to_zero_after !== undefined) { sets.push("scale_to_zero_after = ?"); values.push(fields.scale_to_zero_after); }
  if (fields.last_scale_at !== undefined) { sets.push("last_scale_at = ?"); values.push(fields.last_scale_at); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function nextReplicaHostPort(serverId: number): number {
  const BASE_PORT = 10000;
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM replicas WHERE server_id = ?")
    .get(serverId) as { max_port: number | null } | null;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}
