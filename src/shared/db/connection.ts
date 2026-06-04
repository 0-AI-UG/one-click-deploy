import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { runMigrations } from "../migrations.ts";
import { DATA_DIR } from "../paths.ts";

function log(context: string, ...args: unknown[]) {
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
    provider_id TEXT NOT NULL DEFAULT '',
    ipv4 TEXT NOT NULL DEFAULT '',
    ipv6 TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'cx23',
    location TEXT NOT NULL DEFAULT 'nbg1',
    status TEXT NOT NULL DEFAULT 'provisioning',
    private_ipv4 TEXT NOT NULL DEFAULT '',
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
    network_id: "",
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
