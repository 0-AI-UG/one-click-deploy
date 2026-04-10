<<<<<<< HEAD
export * from "./db/index.ts";
export { default } from "./db/index.ts";
=======
import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { runMigrations } from "./migrations.ts";
import { DATA_DIR } from "./paths.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [db:${context}]`, ...args);
}

export type ServerRow = {
  id: number;
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string | null;
  created_at: string;
};

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
  auth_password: string;
  deploy_mode: string;
  compose_file: string;
  compose_web_service: string;
  volume_id: string | null;
  volume_mount: string | null;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  webhook_path: string;
  github_webhook_id: string;
  deployed_by: string | null;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  scale_to_zero_after: number | null;
  last_scale_at: string | null;
  hetzner_lb_id: string | null;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  wake_token: string | null;
  created_at: string;
};

export type ReplicaRow = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  last_health_at: string | null;
  unhealthy_ticks: number;
  created_at: string;
};

export type ServiceRow = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  port: number;
  env_vars: string;
  credentials: string;
  status: string;
  desired_instances: number;
  created_at: string;
};

export type ServiceInstanceRow = {
  id: number;
  service_id: number;
  server_id: number;
  role: string;
  container_name: string;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  last_health_at: string | null;
  unhealthy_ticks: number;
  created_at: string;
};

export type ServiceLinkRow = {
  id: number;
  service_id: number;
  app_id: number;
  env_prefix: string;
  app_name?: string;
  service_name?: string;
  service_type?: string;
  credentials?: string;
};

export type DeploymentRow = {
  id: number;
  app_id: number;
  image_tag: string;
  git_commit: string;
  deploy_log: string;
  status: string;
  source: string;
  created_at: string;
};

export type MetricSampleRow = {
  replica_id: number;
  app_id: number;
  cpu_percent: number;
  memory_percent: number;
  sampled_at: string;
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

export type ScalingEventRow = {
  id: number;
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason: string;
  created_at: string;
};

export type ServiceDeployJobRow = {
  id: number;
  service_name: string;
  status: string;
  result_json: string;
  started_at: string;
  finished_at: string | null;
};

export type DeployJobEventRow = {
  seq: number;
  ts: string;
  step: string;
  detail: string;
};

export function createDatabase(dbPathOrMemory: string): Database {
  const instance = new Database(dbPathOrMemory);
  instance.run("PRAGMA journal_mode = WAL");
  instance.run("PRAGMA foreign_keys = ON");
  instance.run("PRAGMA busy_timeout = 5000");
  initSchema(instance);
  runMigrations(instance);
  return instance;
}

function initSchema(instance: Database) {
  instance.run(`CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hetzner_id TEXT NOT NULL UNIQUE,
    ipv4 TEXT NOT NULL DEFAULT '',
    ipv6 TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'cx23',
    location TEXT NOT NULL DEFAULT 'nbg1',
    status TEXT NOT NULL DEFAULT 'provisioning',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  instance.run(`CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    git_repo TEXT NOT NULL,
    dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
    container_port INTEGER NOT NULL DEFAULT 3000,
    env_vars TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'deploying',
    deploy_log TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  instance.run(`CREATE TABLE IF NOT EXISTS dns_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'A',
    value TEXT NOT NULL
  )`);

  instance.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  const defaults: Record<string, string> = {
    ssh_public_key: "",
    dns_zone_id: "",
    default_server_type: "",
    default_location: "",
    require_2fa: "1",
  };

  const insertSetting = instance.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value);
  }
}

const dataDir = DATA_DIR;
mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "deploy.db");
log("init", `Opening database at ${dbPath}`);
const db = createDatabase(dbPath);
log("init", "Database opened successfully");

export default db;

// Query helpers
export function getServers(): ServerRow[] {
  return db
    .query("SELECT * FROM servers ORDER BY created_at DESC")
    .all() as ServerRow[];
}

export function getServer(id: number): ServerRow | null {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
}

export function getServerByHetznerId(hetznerId: string): ServerRow | null {
  return db
    .query("SELECT * FROM servers WHERE hetzner_id = ?")
    .get(hetznerId) as ServerRow | null;
}

export function insertServer(server: {
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
}) {
  return db
    .query(
      "INSERT INTO servers (name, hetzner_id, ipv4, ipv6, type, location, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      server.name,
      server.hetzner_id,
      server.ipv4,
      server.ipv6,
      server.type,
      server.location,
      server.status
    ) as ServerRow;
}

export function updateServerStatus(id: number, status: string) {
  db.query("UPDATE servers SET status = ? WHERE id = ?").run(status, id);
}

export function updateServer(id: number, fields: {
  hetzner_id?: string;
  ipv4?: string;
  ipv6?: string;
  status?: string;
}) {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];
  if (fields.hetzner_id !== undefined) { setClauses.push("hetzner_id = ?"); values.push(fields.hetzner_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
  if (setClauses.length === 0) return;
  values.push(id);
  db.query(`UPDATE servers SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteServer(id: number) {
  db.query("DELETE FROM servers WHERE id = ?").run(id);
}

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

/**
 * Insert an app and its first replica in one transaction. Used by deploy.ts
 * so the invariant "every app has >=1 replica" holds throughout the build.
 */
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

/**
 * Distinct servers across an app's replicas. Replaces any code that used to
 * read app.server_id.
 */
export function getServersForApp(appId: number): ServerRow[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as ServerRow[];
}

/**
 * Garbage-collect a server if it has zero replicas, zero apps, and is not
 * the panel's host. Single source of truth for the deletion rule.
 */
export async function gcServerIfEmpty(serverId: number): Promise<void> {
  if (getReplicasByServer(serverId).length > 0) return;
  if (getApps(serverId).length > 0) return;
  if (getPanel()?.server_id === serverId) return;
  // Don't GC servers that host sleeping apps (scale-to-zero)
  const sleepingCount = (db.query("SELECT COUNT(*) as c FROM apps WHERE sleeping_server_id = ?").get(serverId) as { c: number } | null)?.c ?? 0;
  if (sleepingCount > 0) return;
  const server = getServer(serverId);
  if (!server) return;
  // Lazy import to avoid circular dependency between db.ts and hetzner/index.ts.
  const hetzner = await import("./hetzner/index.ts");
  if (server.hetzner_id) {
    try {
      await hetzner.deleteHetznerServer(server.hetzner_id);
    } catch (err) {
      console.error(`[db:gcServerIfEmpty] failed to delete hetzner server ${server.hetzner_id}:`, err);
    }
  }
  deleteServer(serverId);
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
    .get(id) as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deleteApp(id: number) {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

export function getSettings(): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function saveSetting(key: string, value: string) {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value
  );
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

export function deleteDnsRecord(recordId: string) {
  db.query("DELETE FROM dns_records WHERE record_id = ?").run(recordId);
}

// Server host key management
export function updateServerHostKey(id: number, hostKey: string) {
  db.query("UPDATE servers SET ssh_host_key = ? WHERE id = ?").run(hostKey, id);
}

// Deployment history
export function insertDeployment(deployment: {
  app_id: number;
  image_tag: string;
  git_commit: string;
  deploy_log?: string;
  status?: string;
  source?: string;
  created_at?: string;
}) {
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

export function updateDeploymentStatus(id: number, status: string) {
  db.query("UPDATE deployment_history SET status = ? WHERE id = ?").run(status, id);
}

export function appendDeploymentLog(id: number, line: string) {
  db.query(
    "UPDATE deployment_history SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function updateDeploymentGitCommit(id: number, gitCommit: string) {
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

// Deploy jobs (durable progress tracking for in-flight deploys)
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

export function finishDeployJob(jobId: number, result: { ok: boolean; error?: string }) {
  db.query(
    "UPDATE deploy_jobs SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(result.ok ? "done" : "error", JSON.stringify(result), jobId);
}

export function getDeployJob(id: number): { id: number; app_name: string; status: string; result_json: string; started_at: string; finished_at: string | null } | null {
  return db.query("SELECT * FROM deploy_jobs WHERE id = ?").get(id) as { id: number; app_name: string; status: string; result_json: string; started_at: string; finished_at: string | null } | null;
}

export function getDeployJobEvents(jobId: number, sinceSeq: number): Array<{ seq: number; ts: string; step: string; detail: string }> {
  return db
    .query(
      "SELECT seq, ts, step, detail FROM deploy_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(jobId, sinceSeq) as DeployJobEventRow[];
}

// App updates
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

// --- Panel (self-hosted panel, singleton) ---

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
  const row = db.query("SELECT deploy_log FROM panel WHERE id = 1").get() as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export type PanelDeploymentRow = {
  id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

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

// --- Replicas ---

export function insertReplica(replica: {
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status?: string;
}): ReplicaRow {
  return db
    .query(
      "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      replica.app_id,
      replica.server_id,
      replica.host_port,
      replica.container_name,
      replica.status || "deploying"
    ) as ReplicaRow;
}

export function getReplicas(appId: number): ReplicaRow[] {
  return db
    .query("SELECT * FROM replicas WHERE app_id = ? ORDER BY created_at ASC")
    .all(appId) as ReplicaRow[];
}

export function getReplica(id: number): ReplicaRow | null {
  return db.query("SELECT * FROM replicas WHERE id = ?").get(id) as ReplicaRow | null;
}

export function getReplicasByServer(serverId: number): ReplicaRow[] {
  return db
    .query("SELECT * FROM replicas WHERE server_id = ?")
    .all(serverId) as ReplicaRow[];
}

export function updateReplicaStatus(id: number, status: string) {
  db.query("UPDATE replicas SET status = ? WHERE id = ?").run(status, id);
}

export function updateReplicaMetrics(id: number, cpuPercent: number, memoryPercent: number) {
  db.query(
    "UPDATE replicas SET cpu_percent = ?, memory_percent = ?, last_health_at = datetime('now') WHERE id = ?"
  ).run(cpuPercent, memoryPercent, id);
}

export function deleteReplica(id: number) {
  db.query("DELETE FROM replicas WHERE id = ?").run(id);
}

export function getAllReplicas(): ReplicaRow[] {
  return db.query("SELECT * FROM replicas").all() as ReplicaRow[];
}

export function touchReplicaHealth(id: number) {
  db.query("UPDATE replicas SET last_health_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementUnhealthyTicks(id: number): number {
  db.query("UPDATE replicas SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT unhealthy_ticks FROM replicas WHERE id = ?").get(id) as { unhealthy_ticks: number } | null;
  return row?.unhealthy_ticks ?? 0;
}

export function resetUnhealthyTicks(id: number) {
  db.query("UPDATE replicas SET unhealthy_ticks = 0 WHERE id = ?").run(id);
}

// --- Metrics samples ---

export function insertMetricSample(sample: {
  replica_id: number;
  app_id: number;
  cpu_percent: number;
  memory_percent: number;
}) {
  db.query(
    "INSERT INTO metrics_samples (replica_id, app_id, cpu_percent, memory_percent) VALUES (?, ?, ?, ?)"
  ).run(sample.replica_id, sample.app_id, sample.cpu_percent, sample.memory_percent);
}

export function getRecentAppMetrics(appId: number, sinceSeconds: number): MetricSampleRow[] {
  return db
    .query(
      `SELECT replica_id, cpu_percent, memory_percent, sampled_at
       FROM metrics_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(appId, `-${sinceSeconds} seconds`) as MetricSampleRow[];
}

export function pruneOldMetrics(olderThanSeconds: number) {
  db.query(
    "DELETE FROM metrics_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}

// --- Scaling Events ---

export function insertScalingEvent(event: {
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason?: string;
}) {
  return db
    .query(
      "INSERT INTO scaling_events (app_id, event_type, from_count, to_count, reason) VALUES (?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      event.app_id,
      event.event_type,
      event.from_count,
      event.to_count,
      event.reason || ""
    ) as ScalingEventRow;
}

export function getScalingEvents(appId: number, limit = 50): ScalingEventRow[] {
  return db
    .query("SELECT * FROM scaling_events WHERE app_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(appId, limit) as ScalingEventRow[];
}

// --- App Scaling ---

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
  if (fields.hetzner_lb_id !== undefined) { sets.push("hetzner_lb_id = ?"); values.push(fields.hetzner_lb_id); }
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

// --- Users ---

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  totp_secret: string | null;
  totp_enabled: number;
  webauthn_enabled: number;
  github_id: number | null;
  github_username: string;
  github_avatar_url: string;
  github_linked_at: string | null;
  created_at: string;
};

export function getUserCount(): number {
  const row = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number } | null;
  return row?.count ?? 0;
}

export function getUserByUsername(username: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
}

export function getUserById(id: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function getUsers(): UserRow[] {
  return db.query("SELECT id, username, is_admin, totp_enabled, webauthn_enabled, created_at FROM users ORDER BY created_at").all() as UserRow[];
}

export function insertUser(user: { id: string; username: string; password_hash: string; is_admin?: boolean }): void {
  db.query("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)").run(
    user.id, user.username, user.password_hash, user.is_admin ? 1 : 0,
  );
}

export function updateUserPassword(id: string, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function deleteUser(id: string): void {
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

// --- GitHub OAuth ---

export function updateUserGitHub(
  userId: string,
  githubId: number,
  githubUsername: string,
  avatarUrl: string,
): void {
  db.query(
    "UPDATE users SET github_id = ?, github_username = ?, github_avatar_url = ?, github_linked_at = datetime('now') WHERE id = ?"
  ).run(githubId, githubUsername, avatarUrl, userId);
}

export function clearUserGitHub(userId: string): void {
  db.query(
    "UPDATE users SET github_id = NULL, github_username = '', github_avatar_url = '', github_linked_at = NULL WHERE id = ?"
  ).run(userId);
}

// --- TOTP ---

export function setTotpSecret(userId: string, secret: string): void {
  db.query("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, userId);
}

export function enableTotp(userId: string): void {
  db.query("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId);
}

export function disableTotp(userId: string): void {
  db.query("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(userId);
  db.query("DELETE FROM totp_backup_codes WHERE user_id = ?").run(userId);
}

export function getTotpSecret(userId: string): string | null {
  const row = db.query("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null } | null;
  return row?.totp_secret ?? null;
}

export function insertBackupCodes(userId: string, codeHashes: string[]): void {
  db.query("DELETE FROM totp_backup_codes WHERE user_id = ?").run(userId);
  const stmt = db.prepare("INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)");
  for (const hash of codeHashes) {
    stmt.run(crypto.randomUUID(), userId, hash);
  }
}

export function getUnusedBackupCodes(userId: string): Array<{ id: string; code_hash: string }> {
  return db.query("SELECT id, code_hash FROM totp_backup_codes WHERE user_id = ? AND used = 0").all(userId) as Array<{ id: string; code_hash: string }>;
}

export function markBackupCodeUsed(codeId: string): void {
  db.query("UPDATE totp_backup_codes SET used = 1 WHERE id = ?").run(codeId);
}

export function getUnusedBackupCodeCount(userId: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0").get(userId) as { count: number } | null;
  return row?.count ?? 0;
}

// --- WebAuthn ---

export type WebAuthnCredential = {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  device_type: string;
  backed_up: number;
  transports: string;
  name: string;
  created_at: string;
};

export function insertWebAuthnCredential(data: {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  name: string;
}): void {
  db.query(
    "INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    data.id,
    data.userId,
    Buffer.from(data.publicKey),
    data.counter,
    data.deviceType,
    data.backedUp ? 1 : 0,
    JSON.stringify(data.transports),
    data.name,
  );
}

export function getWebAuthnCredentials(userId: string): WebAuthnCredential[] {
  return db.query("SELECT * FROM webauthn_credentials WHERE user_id = ?").all(userId) as WebAuthnCredential[];
}

export function getWebAuthnCredentialById(credentialId: string): WebAuthnCredential | null {
  return (db.query("SELECT * FROM webauthn_credentials WHERE id = ?").get(credentialId) as WebAuthnCredential) ?? null;
}

export function updateWebAuthnCounter(credentialId: string, counter: number): void {
  db.query("UPDATE webauthn_credentials SET counter = ? WHERE id = ?").run(counter, credentialId);
}

export function deleteWebAuthnCredential(credentialId: string): void {
  db.query("DELETE FROM webauthn_credentials WHERE id = ?").run(credentialId);
}

export function enableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 1 WHERE id = ?").run(userId);
}

export function disableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 0 WHERE id = ?").run(userId);
  db.query("DELETE FROM webauthn_credentials WHERE user_id = ?").run(userId);
}

export function getWebAuthnCredentialCount(userId: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = ?").get(userId) as { count: number } | null;
  return row?.count ?? 0;
}

// --- Permissions ---

export const ALL_PERMISSIONS = [
  "apps.deploy",
  "apps.redeploy",
  "apps.rollback",
  "apps.restart",
  "apps.pause",
  "apps.destroy",
  "apps.logs",
  "apps.env",
  "servers.view",
  "servers.delete",
  "volumes.create",
  "volumes.manage",
  "volumes.delete",
  "scaling.manage",
  "webhooks.manage",
  "resources.view",
  "resources.delete",
  "terminal.access",
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];

export function getUserPermissions(userId: string): string[] {
  const rows = db.query("SELECT permission FROM user_permissions WHERE user_id = ?").all(userId) as Array<{ permission: string }>;
  return rows.map((r) => r.permission);
}

export function hasPermission(userId: string, permission: string): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.is_admin) return true;
  const row = db.query("SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?").get(userId, permission);
  return !!row;
}

export function setUserPermissions(userId: string, permissions: string[]): void {
  db.query("DELETE FROM user_permissions WHERE user_id = ?").run(userId);
  const stmt = db.prepare("INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)");
  for (const perm of permissions) {
    stmt.run(userId, perm);
  }
}

// --- Infrastructure Services ---

export function insertService(data: {
  name: string;
  service_type: string;
  version: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances?: number;
}): ServiceRow {
  return db
    .query(
      "INSERT INTO services (name, service_type, version, port, env_vars, credentials, desired_instances) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(data.name, data.service_type, data.version, data.port, data.env_vars, data.credentials, data.desired_instances ?? 1) as ServiceRow;
}

export function getService(id: number): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
}

export function getServiceByName(name: string): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE name = ?").get(name) as ServiceRow | null;
}

export function getServices(): ServiceRow[] {
  return db.query("SELECT * FROM services ORDER BY created_at DESC").all() as ServiceRow[];
}

export function updateServiceStatus(id: number, status: string): void {
  db.query("UPDATE services SET status = ? WHERE id = ?").run(status, id);
}

export function updateServiceCredentials(id: number, credentials: string): void {
  db.query("UPDATE services SET credentials = ? WHERE id = ?").run(credentials, id);
}

export function updateServiceDesiredInstances(id: number, count: number): void {
  db.query("UPDATE services SET desired_instances = ? WHERE id = ?").run(count, id);
}

export function deleteService(id: number): void {
  db.query("DELETE FROM services WHERE id = ?").run(id);
}

// --- Service Instances ---

export function insertServiceInstance(data: {
  service_id: number;
  server_id: number;
  role: string;
  container_name: string;
  host_port: number;
  volume_id?: string;
  volume_mount?: string;
  status?: string;
}): ServiceInstanceRow {
  return db
    .query(
      "INSERT INTO service_instances (service_id, server_id, role, container_name, host_port, volume_id, volume_mount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      data.service_id,
      data.server_id,
      data.role,
      data.container_name,
      data.host_port,
      data.volume_id || "",
      data.volume_mount || "",
      data.status || "deploying"
    ) as ServiceInstanceRow;
}

export function getServiceInstances(serviceId: number): ServiceInstanceRow[] {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? ORDER BY created_at ASC")
    .all(serviceId) as ServiceInstanceRow[];
}

export function getServiceInstance(id: number): ServiceInstanceRow | null {
  return db.query("SELECT * FROM service_instances WHERE id = ?").get(id) as ServiceInstanceRow | null;
}

export function getPrimaryInstance(serviceId: number): ServiceInstanceRow | null {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? AND role = 'primary'")
    .get(serviceId) as ServiceInstanceRow | null;
}

export function getReplicaInstances(serviceId: number): ServiceInstanceRow[] {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? AND role = 'replica' ORDER BY created_at ASC")
    .all(serviceId) as ServiceInstanceRow[];
}

export function getAllServiceInstances(): ServiceInstanceRow[] {
  return db.query("SELECT * FROM service_instances").all() as ServiceInstanceRow[];
}

export function getServiceInstancesByServer(serverId: number): ServiceInstanceRow[] {
  return db
    .query("SELECT * FROM service_instances WHERE server_id = ?")
    .all(serverId) as ServiceInstanceRow[];
}

export function updateServiceInstanceStatus(id: number, status: string): void {
  db.query("UPDATE service_instances SET status = ? WHERE id = ?").run(status, id);
}

export function updateServiceInstanceMetrics(id: number, cpuPercent: number, memoryPercent: number): void {
  db.query(
    "UPDATE service_instances SET cpu_percent = ?, memory_percent = ?, last_health_at = datetime('now') WHERE id = ?"
  ).run(cpuPercent, memoryPercent, id);
}

export function touchServiceInstanceHealth(id: number): void {
  db.query("UPDATE service_instances SET last_health_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementServiceInstanceUnhealthyTicks(id: number): number {
  db.query("UPDATE service_instances SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT unhealthy_ticks FROM service_instances WHERE id = ?").get(id) as { unhealthy_ticks: number } | null;
  return row?.unhealthy_ticks ?? 0;
}

export function resetServiceInstanceUnhealthyTicks(id: number): void {
  db.query("UPDATE service_instances SET unhealthy_ticks = 0 WHERE id = ?").run(id);
}

export function deleteServiceInstance(id: number): void {
  db.query("DELETE FROM service_instances WHERE id = ?").run(id);
}

const SERVICE_BASE_PORT = 15000;

export function nextServiceHostPort(serverId: number): number {
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM service_instances WHERE server_id = ?")
    .get(serverId) as { max_port: number | null } | null;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= SERVICE_BASE_PORT) ? maxPort + 1 : SERVICE_BASE_PORT;
}

// --- Service Links ---

export function insertServiceLink(serviceId: number, appId: number, envPrefix: string): ServiceLinkRow {
  return db
    .query("INSERT INTO service_links (service_id, app_id, env_prefix) VALUES (?, ?, ?) RETURNING *")
    .get(serviceId, appId, envPrefix) as ServiceLinkRow;
}

export function deleteServiceLink(serviceId: number, appId: number): void {
  db.query("DELETE FROM service_links WHERE service_id = ? AND app_id = ?").run(serviceId, appId);
}

export function getServiceLinks(serviceId: number): ServiceLinkRow[] {
  return db
    .query("SELECT sl.*, a.name as app_name FROM service_links sl JOIN apps a ON sl.app_id = a.id WHERE sl.service_id = ?")
    .all(serviceId) as ServiceLinkRow[];
}

export function getLinkedServices(appId: number): ServiceLinkRow[] {
  return db
    .query("SELECT sl.*, s.name as service_name, s.service_type, s.credentials FROM service_links sl JOIN services s ON sl.service_id = s.id WHERE sl.app_id = ?")
    .all(appId) as ServiceLinkRow[];
}

export function getServicesOnServer(serverId: number): ServiceRow[] {
  return db
    .query(`
      SELECT DISTINCT s.* FROM services s
      JOIN service_instances si ON s.id = si.service_id
      WHERE si.server_id = ?
      ORDER BY s.created_at DESC
    `)
    .all(serverId) as ServiceRow[];
}

// --- Service Deploy Jobs ---

export function createServiceDeployJob(serviceName: string): { id: number } {
  return db
    .query("INSERT INTO service_deploy_jobs (service_name) VALUES (?) RETURNING id")
    .get(serviceName) as { id: number };
}

export function appendServiceDeployJobEvent(jobId: number, step: string, detail: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM service_deploy_job_events WHERE job_id = ?")
    .get(jobId) as { next: number };
  db.query(
    "INSERT INTO service_deploy_job_events (job_id, seq, step, detail) VALUES (?, ?, ?, ?)"
  ).run(jobId, row.next, step, detail);
  return row.next;
}

export function finishServiceDeployJob(jobId: number, result: { ok: boolean; error?: string }): void {
  db.query(
    "UPDATE service_deploy_jobs SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(result.ok ? "done" : "error", JSON.stringify(result), jobId);
}

export function getServiceDeployJob(id: number): ServiceDeployJobRow | null {
  return db.query("SELECT * FROM service_deploy_jobs WHERE id = ?").get(id) as ServiceDeployJobRow | null;
}

export function getServiceDeployJobEvents(jobId: number, sinceSeq: number): DeployJobEventRow[] {
  return db
    .query(
      "SELECT seq, ts, step, detail FROM service_deploy_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(jobId, sinceSeq) as DeployJobEventRow[];
}
>>>>>>> worktree-agent-a8d64196
