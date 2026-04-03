import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { runMigrations } from "./migrations.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [db:${context}]`, ...args);
}

export function createDatabase(dbPathOrMemory: string): Database {
  const instance = new Database(dbPathOrMemory);
  instance.run("PRAGMA journal_mode = WAL");
  instance.run("PRAGMA foreign_keys = ON");
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
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
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
    default_server_type: "cpx12",
    default_location: "nbg1",
  };

  const insertSetting = instance.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value);
  }
}

const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
const dataDir = process.env.OCD_DATA_DIR || path.join(home, ".one-click-deploy");
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
      .query("SELECT * FROM apps WHERE server_id = ? ORDER BY created_at DESC")
      .all(serverId) as any[];
  }
  return db
    .query("SELECT * FROM apps ORDER BY created_at DESC")
    .all() as any[];
}

export function getApp(id: number) {
  return db.query("SELECT * FROM apps WHERE id = ?").get(id) as any;
}

export function insertApp(app: {
  server_id: number;
  name: string;
  domain: string;
  git_repo: string;
  dockerfile_path: string;
  container_port: number;
  env_vars: string;
  auth_password?: string;
}) {
  const hostPort = nextHostPort(app.server_id);
  return db
    .query(
      "INSERT INTO apps (server_id, name, domain, git_repo, dockerfile_path, container_port, host_port, env_vars, auth_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      app.server_id,
      app.name,
      app.domain,
      app.git_repo,
      app.dockerfile_path,
      app.container_port,
      hostPort,
      app.env_vars,
      app.auth_password || ""
    ) as any;
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
}) {
  return db
    .query(
      "INSERT INTO deployment_history (app_id, image_tag, git_commit, deploy_log) VALUES (?, ?, ?, ?) RETURNING *"
    )
    .get(
      deployment.app_id,
      deployment.image_tag,
      deployment.git_commit,
      deployment.deploy_log ?? ""
    ) as any;
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

// App updates
export function updateAppEnvVars(id: number, envVars: string) {
  db.query("UPDATE apps SET env_vars = ? WHERE id = ?").run(envVars, id);
}

export function updateAppDomain(id: number, domain: string) {
  db.query("UPDATE apps SET domain = ? WHERE id = ?").run(domain, id);
}

export function updateAppVolume(id: number, volumeId: string, volumeMount: string) {
  db.query("UPDATE apps SET volume_id = ?, volume_mount = ? WHERE id = ?").run(volumeId, volumeMount, id);
}

export function nextHostPort(serverId: number): number {
  const BASE_PORT = 10000;
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM apps WHERE server_id = ?")
    .get(serverId) as any;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
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
  githubWebhookId: string
) {
  db.query(
    "UPDATE apps SET webhook_enabled = ?, webhook_secret = ?, webhook_branch = ?, github_webhook_id = ? WHERE id = ?"
  ).run(enabled ? 1 : 0, secret, branch, githubWebhookId, id);
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
  // Check both apps and replicas tables for max port on this server
  const appRow = db
    .query("SELECT MAX(host_port) as max_port FROM apps WHERE server_id = ?")
    .get(serverId) as any;
  const replicaRow = db
    .query("SELECT MAX(host_port) as max_port FROM replicas WHERE server_id = ?")
    .get(serverId) as any;
  const maxPort = Math.max(appRow?.max_port || 0, replicaRow?.max_port || 0);
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}
