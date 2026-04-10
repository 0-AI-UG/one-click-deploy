import type { Database } from "bun:sqlite";

function log(context: string, ...args: unknown[]) {
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

      // Data migration: create a replica row for each existing app. Guarded
      // because on fresh installs the apps table is created by initSchema()
      // without server_id/host_port (those columns were dropped in
      // migration 14), so the SELECT below would fail with "no such column".
      // On a fresh DB there are no apps to backfill anyway.
      const cols = db.query("PRAGMA table_info(apps)").all() as { name: string }[];
      const hasLegacyCols = cols.some((c) => c.name === "server_id") &&
                            cols.some((c) => c.name === "host_port");
      if (hasLegacyCols) {
        const apps = db.query("SELECT id, name, server_id, host_port, status FROM apps").all() as Array<{ id: number; name: string; server_id: number; host_port: number; status: string }>;
        const insertReplica = db.prepare(
          "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?)"
        );
        for (const app of apps) {
          insertReplica.run(app.id, app.server_id, app.host_port, app.name, app.status);
        }
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
  {
    version: 12,
    description: "Add panel + panel_deployments tables; migrate any existing ocd-panel apps row out of the apps table",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS panel (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        git_repo TEXT NOT NULL,
        git_branch TEXT NOT NULL DEFAULT 'main',
        container_port INTEGER NOT NULL,
        host_port INTEGER NOT NULL,
        volume_id TEXT NOT NULL DEFAULT '',
        volume_mount TEXT NOT NULL DEFAULT '',
        env_vars TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'running',
        deploy_log TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS panel_deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_tag TEXT NOT NULL,
        git_commit TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'deployed',
        source TEXT NOT NULL DEFAULT 'manual',
        deploy_log TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // Migrate any existing panel-like apps row (hosted instances that were
      // deployed before this split) out of the apps table. Match heuristic:
      // git_repo mentioning "one-click-deploy". If multiple match, take the
      // oldest.
      type LegacyApp = { id: number; server_id: number; name: string; domain: string; git_repo: string; webhook_branch?: string; container_port: number; host_port: number; volume_id?: string; volume_mount?: string; env_vars?: string; status?: string; deploy_log?: string; created_at: string };
      const panelApp = db
        .query(
          "SELECT * FROM apps WHERE git_repo LIKE '%one-click-deploy%' ORDER BY id ASC LIMIT 1",
        )
        .get() as LegacyApp | null;

      if (panelApp) {
        db.query(
          "INSERT INTO panel (id, server_id, name, domain, git_repo, git_branch, container_port, host_port, volume_id, volume_mount, env_vars, status, deploy_log, created_at) " +
            "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          panelApp.server_id,
          panelApp.name,
          panelApp.domain,
          panelApp.git_repo,
          panelApp.webhook_branch || "main",
          panelApp.container_port,
          panelApp.host_port,
          panelApp.volume_id || "",
          panelApp.volume_mount || "",
          panelApp.env_vars || "{}",
          panelApp.status || "running",
          panelApp.deploy_log || "",
          panelApp.created_at,
        );

        // Carry forward the existing deployment history for the panel.
        const oldDeploys = db
          .query(
            "SELECT image_tag, git_commit, status, source, deploy_log, created_at FROM deployment_history WHERE app_id = ? ORDER BY id ASC",
          )
          .all(panelApp.id) as Array<{ image_tag: string; git_commit: string; status: string; source: string; deploy_log: string; created_at: string }>;
        const insertPd = db.prepare(
          "INSERT INTO panel_deployments (image_tag, git_commit, status, source, deploy_log, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const d of oldDeploys) {
          insertPd.run(
            d.image_tag,
            d.git_commit,
            d.status,
            d.source,
            d.deploy_log,
            d.created_at,
          );
        }

        // Cascade-deletes via FK: deployment_history, dns_records, replicas,
        // metrics_samples, scaling_events.
        db.query("DELETE FROM apps WHERE id = ?").run(panelApp.id);
      }
    },
  },
  {
    version: 13,
    description: "Track panel DNS record on the panel row so destroyServer can clean it up",
    up: (db) => {
      db.run("ALTER TABLE panel ADD COLUMN dns_zone_id TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE panel ADD COLUMN dns_name TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE panel ADD COLUMN dns_type TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE panel ADD COLUMN dns_value TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 14,
    description: "Drop server_id and host_port from apps; replicas table is now the sole source of truth",
    up: (db) => {
      // SQLite >=3.35 supports DROP COLUMN. Try the simple path first; if it
      // fails (older SQLite or column-with-FK quirks), fall back to the
      // recreate-table dance.
      try {
        db.run("ALTER TABLE apps DROP COLUMN server_id");
        db.run("ALTER TABLE apps DROP COLUMN host_port");
      } catch {
        // Recreate table without server_id/host_port. We need to preserve
        // every other column added through migrations 1-13.
        db.run(`CREATE TABLE apps_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          domain TEXT NOT NULL,
          git_repo TEXT NOT NULL,
          dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
          container_port INTEGER NOT NULL DEFAULT 3000,
          env_vars TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'deploying',
          deploy_log TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          volume_id TEXT NOT NULL DEFAULT '',
          volume_mount TEXT NOT NULL DEFAULT '',
          webhook_enabled INTEGER NOT NULL DEFAULT 0,
          webhook_secret TEXT NOT NULL DEFAULT '',
          webhook_branch TEXT NOT NULL DEFAULT 'main',
          github_webhook_id TEXT NOT NULL DEFAULT '',
          auth_password TEXT NOT NULL DEFAULT '',
          deploy_mode TEXT NOT NULL DEFAULT 'dockerfile',
          compose_file TEXT NOT NULL DEFAULT '',
          compose_web_service TEXT NOT NULL DEFAULT '',
          desired_replicas INTEGER NOT NULL DEFAULT 1,
          min_replicas INTEGER NOT NULL DEFAULT 1,
          max_replicas INTEGER NOT NULL DEFAULT 1,
          autoscale_enabled INTEGER NOT NULL DEFAULT 0,
          autoscale_cpu_threshold INTEGER NOT NULL DEFAULT 80,
          autoscale_mem_threshold INTEGER NOT NULL DEFAULT 85,
          autoscale_cooldown INTEGER NOT NULL DEFAULT 300,
          last_scale_at TEXT,
          hetzner_lb_id TEXT NOT NULL DEFAULT ''
        )`);
        db.run(`INSERT INTO apps_new (
          id, name, domain, git_repo, dockerfile_path, container_port, env_vars,
          status, deploy_log, created_at, volume_id, volume_mount, webhook_enabled,
          webhook_secret, webhook_branch, github_webhook_id, auth_password,
          deploy_mode, compose_file, compose_web_service, desired_replicas,
          min_replicas, max_replicas, autoscale_enabled, autoscale_cpu_threshold,
          autoscale_mem_threshold, autoscale_cooldown, last_scale_at, hetzner_lb_id
        ) SELECT
          id, name, domain, git_repo, dockerfile_path, container_port, env_vars,
          status, deploy_log, created_at, volume_id, volume_mount, webhook_enabled,
          webhook_secret, webhook_branch, github_webhook_id, auth_password,
          deploy_mode, compose_file, compose_web_service, desired_replicas,
          min_replicas, max_replicas, autoscale_enabled, autoscale_cpu_threshold,
          autoscale_mem_threshold, autoscale_cooldown, last_scale_at, hetzner_lb_id
        FROM apps`);
        db.run("DROP TABLE apps");
        db.run("ALTER TABLE apps_new RENAME TO apps");
      }
    },
  },
  {
    version: 15,
    description: "Add webhook fields to panel; collapse self-redeploy source into webhook",
    up: (db) => {
      db.run("ALTER TABLE panel ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE panel ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE panel ADD COLUMN github_webhook_id TEXT NOT NULL DEFAULT ''");
      db.run("UPDATE panel_deployments SET source = 'webhook' WHERE source = 'self-redeploy'");
    },
  },
  {
    version: 16,
    description: "Add deploy_jobs and deploy_job_events for durable progress tracking",
    up: (db) => {
      db.run(`CREATE TABLE deploy_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        result_json TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      )`);
      db.run(`CREATE TABLE deploy_job_events (
        job_id INTEGER NOT NULL REFERENCES deploy_jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        step TEXT NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      )`);
    },
  },
  {
    version: 17,
    description: "Add webhook_path filter to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_path TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 18,
    description: "Add WebAuthn credentials table and webauthn_enabled flag on users",
    up: (db) => {
      db.run(`CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT NOT NULL DEFAULT '',
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]',
        name TEXT NOT NULL DEFAULT 'Passkey',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("CREATE INDEX idx_webauthn_user ON webauthn_credentials(user_id)");
      db.run("ALTER TABLE users ADD COLUMN webauthn_enabled INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 19,
    description: "Rename email to username and strip @domain from existing values",
    up: (db) => {
      // SQLite doesn't support RENAME COLUMN on older versions, so use the
      // recreate-table approach for maximum compatibility.
      db.run(`CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        webauthn_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // Copy data, stripping @domain from email to produce username.
      // If two emails would collapse to the same username (unlikely but
      // possible), the UNIQUE constraint will cause a failure — admin must
      // resolve manually.
      db.run(`INSERT INTO users_new (id, username, password_hash, is_admin, totp_secret, totp_enabled, webauthn_enabled, created_at)
        SELECT id,
               CASE WHEN INSTR(email, '@') > 0 THEN SUBSTR(email, 1, INSTR(email, '@') - 1) ELSE email END,
               password_hash, is_admin, totp_secret, totp_enabled, webauthn_enabled, created_at
        FROM users`);

      db.run("DROP TABLE users");
      db.run("ALTER TABLE users_new RENAME TO users");

      // Recreate the webauthn FK index (points at users.id — unchanged, but
      // dropping the old table removed it).
      db.run("CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id)");
    },
  },
  {
    version: 20,
    description: "Add infrastructure services tables",
    up: (db) => {
      db.run(`CREATE TABLE services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        service_type TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'deploying',
        port INTEGER NOT NULL,
        env_vars TEXT NOT NULL DEFAULT '{}',
        credentials TEXT NOT NULL DEFAULT '{}',
        desired_instances INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      db.run(`CREATE TABLE service_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id),
        role TEXT NOT NULL DEFAULT 'primary',
        container_name TEXT NOT NULL,
        host_port INTEGER NOT NULL,
        volume_id TEXT NOT NULL DEFAULT '',
        volume_mount TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'deploying',
        cpu_percent REAL NOT NULL DEFAULT 0,
        memory_percent REAL NOT NULL DEFAULT 0,
        unhealthy_ticks INTEGER NOT NULL DEFAULT 0,
        last_health_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("CREATE INDEX idx_si_service ON service_instances(service_id)");
      db.run("CREATE INDEX idx_si_server ON service_instances(server_id)");

      db.run(`CREATE TABLE service_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        env_prefix TEXT NOT NULL DEFAULT 'DATABASE',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(service_id, app_id)
      )`);

      db.run(`CREATE TABLE service_deploy_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        result_json TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      )`);

      db.run(`CREATE TABLE service_deploy_job_events (
        job_id INTEGER NOT NULL REFERENCES service_deploy_jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        step TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (job_id, seq)
      )`);
    },
  },
  {
    version: 21,
    description: "Add GitHub OAuth account linking columns to users and deployed_by to apps",
    up: (db) => {
      db.run("ALTER TABLE users ADD COLUMN github_id INTEGER");
      db.run("ALTER TABLE users ADD COLUMN github_username TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE users ADD COLUMN github_avatar_url TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE users ADD COLUMN github_linked_at TEXT");
      db.run("CREATE UNIQUE INDEX idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL");
      // Track which user deployed the app so webhook redeploys can use their GitHub token
      db.run("ALTER TABLE apps ADD COLUMN deployed_by TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 22,
    description: "Add scale-to-zero support: sleeping state and idle timeout",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN sleeping_server_id INTEGER");
      db.run("ALTER TABLE apps ADD COLUMN sleeping_host_port INTEGER");
      // Seconds of sustained idle before autoscaler sleeps the app (0 = use normal scale-down rules)
      db.run("ALTER TABLE apps ADD COLUMN scale_to_zero_after INTEGER NOT NULL DEFAULT 300");
    },
  },
  {
    version: 23,
    description: "Add wake_token to apps for authenticated wake endpoints",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN wake_token TEXT");
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
