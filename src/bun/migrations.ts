import type { Database } from "bun:sqlite";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [migrations:${context}]`, ...args);
}

export type Migration = {
  version: number;
  description: string;
  up: (db: Database) => void;
};

export const migrations: Migration[] = [
  {
    version: 1,
    description: "Add ssh_host_key to servers",
    up: (db) => {
      db.run("ALTER TABLE servers ADD COLUMN ssh_host_key TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 2,
    description: "Add deployment_history table",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS deployment_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        image_tag TEXT NOT NULL,
        git_commit TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'deployed',
        deploy_log TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    version: 3,
    description: "Add volume_id and volume_mount to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN volume_id TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN volume_mount TEXT NOT NULL DEFAULT ''");
    },
  },
];

export function runMigrations(db: Database): void {
  // Create schema_version table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL DEFAULT 0
  )`);

  // Ensure there's a row
  const row = db.query("SELECT version FROM schema_version").get() as
    | { version: number }
    | null;
  let currentVersion: number;
  if (!row) {
    db.run("INSERT INTO schema_version (version) VALUES (0)");
    currentVersion = 0;
  } else {
    currentVersion = row.version;
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    log("run", `Schema is up to date (version ${currentVersion})`);
    return;
  }

  log("run", `Running ${pending.length} migration(s) from version ${currentVersion}...`);

  for (const migration of pending) {
    log("run", `Migration ${migration.version}: ${migration.description}`);
    db.run("BEGIN TRANSACTION");
    try {
      migration.up(db);
      db.run("UPDATE schema_version SET version = ?", [migration.version]);
      db.run("COMMIT");
      log("run", `Migration ${migration.version} applied successfully`);
    } catch (err) {
      db.run("ROLLBACK");
      log("run", `Migration ${migration.version} failed:`, err);
      throw new Error(
        `Migration ${migration.version} (${migration.description}) failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  log("run", `All migrations applied. Schema now at version ${pending[pending.length - 1].version}`);
}
