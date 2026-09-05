import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync, existsSync, rmSync, readdirSync } from "fs";
import { runMigrations, migrations } from "../migrations.ts";
import { DATA_DIR } from "../paths.ts";
import { CURRENT_SCHEMA_VERSION, initializeCurrentSchema } from "./current-schema.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [db:${context}]`, ...args);
}

export function createDatabase(dbPathOrMemory: string): Database {
  const instance = new Database(dbPathOrMemory);
  instance.run("PRAGMA journal_mode = WAL");
  instance.run("PRAGMA foreign_keys = ON");
  instance.run("PRAGMA busy_timeout = 5000");
  if (isUninitialized(instance)) {
    initializeCurrentSchema(instance);
  } else {
    initLegacySchema(instance);
    backupBeforeMigrating(instance, dbPathOrMemory);
    runMigrations(instance);
    assertCurrentSchema(instance);
  }
  return instance;
}

function isUninitialized(instance: Database): boolean {
  return !instance.query(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`).get();
}

function assertCurrentSchema(instance: Database): void {
  const version = currentSchemaVersion(instance);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${version} is not supported by this clean-cut release (expected ${CURRENT_SCHEMA_VERSION}). ` +
      "Run the release-specific offline cutover before starting the panel.",
    );
  }
}

/** Snapshot the DB whenever a migration is about to run.
 *
 *  Each migration is transactional and rolls back on failure, so this is not
 *  the first line of defence — it is the one that matters when a migration
 *  *succeeds* and is wrong, which no transaction can undo. Uses SQLite's own
 *  VACUUM INTO so the copy is consistent without stopping writers, and keeps
 *  only the newest few so the disk cannot fill.
 */
function backupBeforeMigrating(instance: Database, dbPath: string): void {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return;
  try {
    const pending = pendingMigrationCount(instance);
    if (pending === 0) return;

    const version = currentSchemaVersion(instance);
    const dest = `${dbPath}.pre-migration-v${version}`;
    if (existsSync(dest)) rmSync(dest, { force: true });
    instance.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    log("backup", `${pending} migration(s) pending — snapshotted v${version} to ${dest}`);
    pruneOldBackups(dbPath);
  } catch (err) {
    // A failed backup must not block startup; the migration itself is still
    // transactional. Log loudly so it is visible in the deploy output.
    log("backup", `WARNING: pre-migration backup failed (continuing): ${err}`);
  }
}

/** Reads schema_version without creating it — runMigrations owns that. */
function currentSchemaVersion(instance: Database): number {
  const exists = instance
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!exists) return 0;
  const row = instance.query("SELECT version FROM schema_version").get() as
    | { version: number }
    | null;
  return row?.version ?? 0;
}

function pendingMigrationCount(instance: Database): number {
  const current = currentSchemaVersion(instance);
  return migrations.filter((m) => m.version > current).length;
}

const BACKUPS_TO_KEEP = 3;

function pruneOldBackups(dbPath: string): void {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.pre-migration-v`;
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({ f, v: parseInt(f.slice(prefix.length), 10) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  for (const old of backups.slice(BACKUPS_TO_KEEP)) {
    rmSync(path.join(dir, old.f), { force: true });
  }
}

/** Bootstrap only the historical migration chain for an existing old database. */
function initLegacySchema(instance: Database) {
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
    provider TEXT NOT NULL DEFAULT '',
    ownership TEXT NOT NULL DEFAULT 'connected',
    management_address TEXT NOT NULL DEFAULT '',
    ssh_user TEXT NOT NULL DEFAULT 'root',
    ssh_port INTEGER NOT NULL DEFAULT 22,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Historical v0 bootstrap shape. New databases immediately run the complete
  // migration chain; migration 105 removes these source-build columns before
  // createDatabase returns, so callers only ever observe the digest-only schema.
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

  instance.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  const defaults: Record<string, string> = {
    ssh_public_key: "",
    default_domain_suffix: "",
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
