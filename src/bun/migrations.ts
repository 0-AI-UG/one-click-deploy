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
  {
    version: 4,
    description: "Add webhook fields to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN webhook_branch TEXT NOT NULL DEFAULT 'main'");
      db.run("ALTER TABLE apps ADD COLUMN github_webhook_id TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 5,
    description: "Add host_port to apps for unique port mapping",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN host_port INTEGER NOT NULL DEFAULT 0");
      // Backfill existing apps: set host_port = container_port
      db.run("UPDATE apps SET host_port = container_port WHERE host_port = 0");
    },
  },
  {
    version: 6,
    description: "Add auth_password to apps for password-protected deployments",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN auth_password TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 7,
    description: "Add Docker Compose support fields to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN deploy_mode TEXT NOT NULL DEFAULT 'dockerfile'");
      db.run("ALTER TABLE apps ADD COLUMN compose_file TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN compose_web_service TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 8,
    description: "Add horizontal scaling support (replicas, scaling_events, app scaling columns)",
    up: (db) => {
      // New table: replicas
      db.run(`CREATE TABLE replicas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        host_port INTEGER NOT NULL,
        container_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'deploying',
        cpu_percent REAL NOT NULL DEFAULT 0,
        memory_percent REAL NOT NULL DEFAULT 0,
        last_health_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // New table: scaling_events
      db.run(`CREATE TABLE scaling_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        from_count INTEGER NOT NULL,
        to_count INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // New columns on apps for scaling config
      db.run("ALTER TABLE apps ADD COLUMN desired_replicas INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE apps ADD COLUMN min_replicas INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE apps ADD COLUMN max_replicas INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE apps ADD COLUMN autoscale_enabled INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN autoscale_cpu_threshold INTEGER NOT NULL DEFAULT 80");
      db.run("ALTER TABLE apps ADD COLUMN autoscale_mem_threshold INTEGER NOT NULL DEFAULT 85");
      db.run("ALTER TABLE apps ADD COLUMN autoscale_cooldown INTEGER NOT NULL DEFAULT 300");
      db.run("ALTER TABLE apps ADD COLUMN last_scale_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN hetzner_lb_id TEXT NOT NULL DEFAULT ''");

      // Data migration: create a replica row for each existing app
      const apps = db.query("SELECT id, name, server_id, host_port, status FROM apps").all() as any[];
      const insertReplica = db.prepare(
        "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?)"
      );
      for (const app of apps) {
        insertReplica.run(app.id, app.server_id, app.host_port, app.name, app.status);
      }
    },
  },
  {
    version: 9,
    description: "Add users, permissions, TOTP backup codes, and encrypted secrets for web mode",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS totp_backup_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        UNIQUE(user_id, permission)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS encrypted_secrets (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    version: 10,
    description: "Add source column to deployment_history",
    up: (db) => {
      db.run("ALTER TABLE deployment_history ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    },
  },
  {
    version: 11,
    description: "Add metrics_samples table and unhealthy_ticks counter on replicas",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS metrics_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        replica_id INTEGER NOT NULL REFERENCES replicas(id) ON DELETE CASCADE,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        cpu_percent REAL NOT NULL,
        memory_percent REAL NOT NULL,
        sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("CREATE INDEX IF NOT EXISTS idx_metrics_samples_app_time ON metrics_samples(app_id, sampled_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_metrics_samples_replica_time ON metrics_samples(replica_id, sampled_at)");
      db.run("ALTER TABLE replicas ADD COLUMN unhealthy_ticks INTEGER NOT NULL DEFAULT 0");
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
        `Database migration failed (${migration.description}). The app may need to be reinstalled if this persists.`
      );
    }
  }

  log("run", `All migrations applied. Schema now at version ${pending[pending.length - 1].version}`);
}
