import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { runMigrations } from "./migrations.ts";
import { DATA_DIR } from "./paths.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [db:${context}]`, ...args);
}

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
export function getServers() {
  return db
    .query("SELECT * FROM servers ORDER BY created_at DESC")
    .all() as any[];
}

export function getServer(id: number) {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as any;
}

export function getServerByHetznerId(hetznerId: string) {
  return db
    .query("SELECT * FROM servers WHERE hetzner_id = ?")
    .get(hetznerId) as any;
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
    ) as any;
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
  const values: any[] = [];
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

/**
 * Distinct servers across an app's replicas. Replaces any code that used to
 * read app.server_id.
 */
export function getServersForApp(appId: number): any[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as any[];
}

/**
 * Garbage-collect a server if it has zero replicas, zero apps, and is not
 * the panel's host. Single source of truth for the deletion rule.
 */
export async function gcServerIfEmpty(serverId: number): Promise<void> {
  if (getReplicasByServer(serverId).length > 0) return;
  if (getApps(serverId).length > 0) return;
  if (getPanel()?.server_id === serverId) return;
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

export function getSettings(): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as any[];
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
      ) as any;
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
    ) as any;
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

export function getDeployments(appId: number) {
  return db
    .query(
      "SELECT * FROM deployment_history WHERE app_id = ? ORDER BY created_at DESC"
    )
    .all(appId) as any[];
}

export function getDeployment(id: number) {
  return db
    .query("SELECT * FROM deployment_history WHERE id = ?")
    .get(id) as any;
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
  return db.query("SELECT * FROM deploy_jobs WHERE id = ?").get(id) as any;
}

export function getDeployJobEvents(jobId: number, sinceSeq: number): Array<{ seq: number; ts: string; step: string; detail: string }> {
  return db
    .query(
      "SELECT seq, ts, step, detail FROM deploy_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(jobId, sinceSeq) as any[];
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

// --- Replicas ---

export function insertReplica(replica: {
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status?: string;
}) {
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
    ) as any;
}

export function getReplicas(appId: number) {
  return db
    .query("SELECT * FROM replicas WHERE app_id = ? ORDER BY created_at ASC")
    .all(appId) as any[];
}

export function getReplica(id: number) {
  return db.query("SELECT * FROM replicas WHERE id = ?").get(id) as any;
}

export function getReplicasByServer(serverId: number) {
  return db
    .query("SELECT * FROM replicas WHERE server_id = ?")
    .all(serverId) as any[];
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

export function getAllReplicas() {
  return db.query("SELECT * FROM replicas").all() as any[];
}

export function touchReplicaHealth(id: number) {
  db.query("UPDATE replicas SET last_health_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementUnhealthyTicks(id: number): number {
  db.query("UPDATE replicas SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT unhealthy_ticks FROM replicas WHERE id = ?").get(id) as any;
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

export function getRecentAppMetrics(appId: number, sinceSeconds: number) {
  return db
    .query(
      `SELECT replica_id, cpu_percent, memory_percent, sampled_at
       FROM metrics_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(appId, `-${sinceSeconds} seconds`) as any[];
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
    ) as any;
}

export function getScalingEvents(appId: number, limit = 50) {
  return db
    .query("SELECT * FROM scaling_events WHERE app_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(appId, limit) as any[];
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
    .get(serverId) as any;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}

// --- Users ---

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  is_admin: number;
  totp_secret: string | null;
  totp_enabled: number;
  webauthn_enabled: number;
  created_at: string;
};

export function getUserCount(): number {
  const row = db.query("SELECT COUNT(*) as count FROM users").get() as any;
  return row?.count ?? 0;
}

export function getUserByEmail(email: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null;
}

export function getUserById(id: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function getUsers(): UserRow[] {
  return db.query("SELECT id, email, is_admin, totp_enabled, created_at FROM users ORDER BY created_at").all() as UserRow[];
}

export function insertUser(user: { id: string; email: string; password_hash: string; is_admin?: boolean }): void {
  db.query("INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, ?)").run(
    user.id, user.email, user.password_hash, user.is_admin ? 1 : 0,
  );
}

export function updateUserPassword(id: string, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function deleteUser(id: string): void {
  db.query("DELETE FROM users WHERE id = ?").run(id);
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
  const row = db.query("SELECT totp_secret FROM users WHERE id = ?").get(userId) as any;
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
  return db.query("SELECT id, code_hash FROM totp_backup_codes WHERE user_id = ? AND used = 0").all(userId) as any[];
}

export function markBackupCodeUsed(codeId: string): void {
  db.query("UPDATE totp_backup_codes SET used = 1 WHERE id = ?").run(codeId);
}

export function getUnusedBackupCodeCount(userId: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0").get(userId) as any;
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
  const row = db.query("SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = ?").get(userId) as any;
  return row?.count ?? 0;
}

// --- Permissions ---

export const ALL_PERMISSIONS = [
  "settings.manage",
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
  const rows = db.query("SELECT permission FROM user_permissions WHERE user_id = ?").all(userId) as any[];
  return rows.map((r: any) => r.permission);
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
