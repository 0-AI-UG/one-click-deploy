import type { Database } from "bun:sqlite";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [migrations:${context}]`, ...args);
}

export type Migration = {
  version: number;
  description: string;
  up: (db: Database) => void;
  /** Set for migrations that recreate parent tables whose children cascade on
   *  delete. SQLite treats `DROP TABLE` with `foreign_keys = ON` as a
   *  cascading delete against any ON DELETE CASCADE children, wiping them.
   *  The only way to avoid that is to toggle the pragma OFF *outside* the
   *  transaction — which is what the runner does when this flag is true. */
  disableForeignKeys?: boolean;
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
  {
    version: 24,
    description: "Generalize provider columns: hetzner_id -> provider_id, add provider column to servers, rename hetzner_lb_id",
    up: (db) => {
      // Check if columns already have new names (fresh DB created with latest schema)
      const cols = db.query("PRAGMA table_info(servers)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("provider")) {
        db.run("ALTER TABLE servers ADD COLUMN provider TEXT NOT NULL DEFAULT 'hetzner'");
      }
      if (colNames.has("hetzner_id")) {
        db.run("ALTER TABLE servers RENAME COLUMN hetzner_id TO provider_id");
      }
      const appCols = db.query("PRAGMA table_info(apps)").all() as { name: string }[];
      const appColNames = new Set(appCols.map((c) => c.name));
      if (appColNames.has("hetzner_lb_id")) {
        db.run("ALTER TABLE apps RENAME COLUMN hetzner_lb_id TO lb_provider_id");
      }
      // Settings table may not exist in test fixtures that only create servers + apps
      const hasSettings = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
      if (hasSettings) {
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('compute_provider', 'hetzner')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('dns_provider', 'hetzner-dns')");
      }
    },
  },
  {
    version: 25,
    description: "Add stopped_at to replicas for freeze-eligibility tracking",
    up: (db) => {
      db.run("ALTER TABLE replicas ADD COLUMN stopped_at TEXT");
    },
  },
  {
    version: 26,
    description:
      "Add freeze state fields to servers and create freeze_jobs table",
    up: (db) => {
      // servers: lifecycle state (materialized|frozen) + snapshot pointers.
      // Guarded for fresh DBs created by initSchema() with the latest columns
      // already present (same pattern as migration 24).
      const cols = db
        .query("PRAGMA table_info(servers)")
        .all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("state")) {
        db.run(
          "ALTER TABLE servers ADD COLUMN state TEXT NOT NULL DEFAULT 'materialized'",
        );
      }
      if (!colNames.has("snapshot_id")) {
        db.run(
          "ALTER TABLE servers ADD COLUMN snapshot_id TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!colNames.has("frozen_volume_ids")) {
        // JSON-encoded array of provider volume IDs. Stored as TEXT so the
        // column stays usable on SQLite builds without JSON1.
        db.run(
          "ALTER TABLE servers ADD COLUMN frozen_volume_ids TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!colNames.has("frozen_at")) {
        db.run("ALTER TABLE servers ADD COLUMN frozen_at TEXT");
      }
      if (!colNames.has("freeze_failed_at")) {
        db.run("ALTER TABLE servers ADD COLUMN freeze_failed_at TEXT");
      }

      // Durable queue for the freeze worker. Survives panel restart.
      db.run(`CREATE TABLE IF NOT EXISTS freeze_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending',
        snapshot_id TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        error TEXT NOT NULL DEFAULT ''
      )`);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_freeze_jobs_server ON freeze_jobs(server_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_freeze_jobs_state ON freeze_jobs(state)",
      );
    },
  },
  {
    version: 27,
    description:
      "Drop UNIQUE on servers.provider_id so frozen servers can share ''",
    disableForeignKeys: true,
    up: (db) => {
      // Phase 3 frees the cloud instance when a server is frozen and clears
      // `provider_id` to ''. Multiple frozen servers cannot coexist under the
      // original UNIQUE constraint. Recreate the table without it.
      //
      // Skip the recreate if `initSchema()` already built the table without
      // UNIQUE (fresh DBs created by a newer connection.ts). Detect this by
      // looking at sqlite_master for the UNIQUE keyword on provider_id.
      const ddlRow = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'servers'",
        )
        .get() as { sql: string } | null;
      if (!ddlRow || !/provider_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddlRow.sql)) {
        return;
      }

      db.run(`CREATE TABLE servers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'hetzner',
        ipv4 TEXT NOT NULL DEFAULT '',
        ipv6 TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'cx23',
        location TEXT NOT NULL DEFAULT 'nbg1',
        status TEXT NOT NULL DEFAULT 'provisioning',
        ssh_host_key TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'materialized',
        snapshot_id TEXT NOT NULL DEFAULT '',
        frozen_volume_ids TEXT NOT NULL DEFAULT '',
        frozen_at TEXT,
        freeze_failed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run(`INSERT INTO servers_new (
        id, name, provider_id, provider, ipv4, ipv6, type, location, status,
        ssh_host_key, state, snapshot_id, frozen_volume_ids, frozen_at,
        freeze_failed_at, created_at
      ) SELECT
        id, name, provider_id, provider, ipv4, ipv6, type, location, status,
        ssh_host_key, state, snapshot_id, frozen_volume_ids, frozen_at,
        freeze_failed_at, created_at
      FROM servers`);
      db.run("DROP TABLE servers");
      db.run("ALTER TABLE servers_new RENAME TO servers");
    },
  },
  {
    version: 28,
    description:
      "Add apps.wake_page_on_panel flag for Phase 5 on-demand TLS authorization",
    up: (db) => {
      // Set when the freeze worker installs a wake page route on the panel's
      // Caddy for this app, cleared when the wake path removes it. The Caddy
      // on-demand-TLS `ask` endpoint uses this flag as the sole authorization
      // signal — only apps whose wake page legitimately lives on the panel
      // right now may trigger Let's Encrypt cert minting for their domain.
      const cols = db
        .query("PRAGMA table_info(apps)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "wake_page_on_panel")) {
        db.run(
          "ALTER TABLE apps ADD COLUMN wake_page_on_panel INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    version: 29,
    description:
      "Add servers.private_ipv4 for shared private network routing",
    up: (db) => {
      const cols = db
        .query("PRAGMA table_info(servers)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "private_ipv4")) {
        db.run(
          "ALTER TABLE servers ADD COLUMN private_ipv4 TEXT NOT NULL DEFAULT ''",
        );
      }
      const hasSettings = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
        )
        .get();
      if (hasSettings) {
        db.run(
          "INSERT OR IGNORE INTO settings (key, value) VALUES ('network_id', '')",
        );
      }
    },
  },
  {
    version: 30,
    description:
      "Drop apps.lb_provider_id — Hetzner load balancers replaced by panel Caddy ingress",
    up: (db) => {
      const cols = db
        .query("PRAGMA table_info(apps)")
        .all() as { name: string }[];
      if (cols.some((c) => c.name === "lb_provider_id")) {
        try {
          db.run("ALTER TABLE apps DROP COLUMN lb_provider_id");
        } catch {
          // SQLite older than 3.35 — fall back to table recreate. We only
          // ship on Bun ≥ 1.1, which embeds SQLite 3.45+, so this path is
          // defensive but effectively unreachable in production.
          db.run("ALTER TABLE apps RENAME TO apps_pre_30");
          const oldCols = db
            .query("PRAGMA table_info(apps_pre_30)")
            .all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
          const keep = oldCols.filter((c) => c.name !== "lb_provider_id");
          const colDefs = keep
            .map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}${c.pk ? " PRIMARY KEY AUTOINCREMENT" : ""}`)
            .join(", ");
          db.run(`CREATE TABLE apps (${colDefs})`);
          const names = keep.map((c) => c.name).join(", ");
          db.run(`INSERT INTO apps (${names}) SELECT ${names} FROM apps_pre_30`);
          db.run("DROP TABLE apps_pre_30");
        }
      }
    },
  },
  {
    version: 31,
    description:
      "Remove deep-sleep machinery: drop freeze_jobs, apps.wake_page_on_panel, and servers freeze columns",
    disableForeignKeys: true,
    up: (db) => {
      // Scale-to-zero only pauses containers now; the freeze worker + all
      // snapshot/deep-wake state is gone. This migration drops the dead
      // tables/columns. No frozen servers exist in the wild (confirmed by
      // the operator), so no rescue path is needed.

      db.run("DROP TABLE IF EXISTS freeze_jobs");

      // 1. apps.wake_page_on_panel
      const appCols = db
        .query("PRAGMA table_info(apps)")
        .all() as { name: string }[];
      if (appCols.some((c) => c.name === "wake_page_on_panel")) {
        try {
          db.run("ALTER TABLE apps DROP COLUMN wake_page_on_panel");
        } catch {
          // Old-SQLite fallback: table recreate, copying every column
          // except the one we're dropping.
          db.run("ALTER TABLE apps RENAME TO apps_pre_31");
          const oldCols = db
            .query("PRAGMA table_info(apps_pre_31)")
            .all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
          const keep = oldCols.filter((c) => c.name !== "wake_page_on_panel");
          const colDefs = keep
            .map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}${c.pk ? " PRIMARY KEY AUTOINCREMENT" : ""}`)
            .join(", ");
          db.run(`CREATE TABLE apps (${colDefs})`);
          const names = keep.map((c) => c.name).join(", ");
          db.run(`INSERT INTO apps (${names}) SELECT ${names} FROM apps_pre_31`);
          db.run("DROP TABLE apps_pre_31");
        }
      }

      // 2. servers: drop state / snapshot_id / frozen_volume_ids /
      //    frozen_at / freeze_failed_at in one table-recreate pass.
      const serverCols = db
        .query("PRAGMA table_info(servers)")
        .all() as { name: string }[];
      const serverColNames = new Set(serverCols.map((c) => c.name));
      const freezeCols = [
        "state",
        "snapshot_id",
        "frozen_volume_ids",
        "frozen_at",
        "freeze_failed_at",
      ];
      const hasAny = freezeCols.some((c) => serverColNames.has(c));
      if (hasAny) {
        db.run(`CREATE TABLE servers_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT 'hetzner',
          ipv4 TEXT NOT NULL DEFAULT '',
          ipv6 TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'cx23',
          location TEXT NOT NULL DEFAULT 'nbg1',
          status TEXT NOT NULL DEFAULT 'provisioning',
          ssh_host_key TEXT NOT NULL DEFAULT '',
          private_ipv4 TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.run(`INSERT INTO servers_new (
          id, name, provider_id, provider, ipv4, ipv6, type, location, status,
          ssh_host_key, private_ipv4, created_at
        ) SELECT
          id, name, provider_id, provider, ipv4, ipv6, type, location, status,
          ssh_host_key, private_ipv4, created_at
        FROM servers`);
        db.run("DROP TABLE servers");
        db.run("ALTER TABLE servers_new RENAME TO servers");
      }
    },
  },
  {
    version: 32,
    description: "Add deploy_sessions table for persisting deploy form state",
    up: (db) => {
      db.run(`CREATE TABLE deploy_sessions (
        user_id TEXT PRIMARY KEY,
        form_data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    version: 33,
    description: "Add environments, env_templates, app_env_templates tables and apps.environment_id",
    up: (db) => {
      db.run(`CREATE TABLE environments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        env_vars TEXT NOT NULL DEFAULT '{"version":2,"entries":[]}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run(`CREATE TABLE env_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        env_vars TEXT NOT NULL DEFAULT '{"version":2,"entries":[]}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run(`CREATE TABLE app_env_templates (
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        template_id INTEGER NOT NULL REFERENCES env_templates(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app_id, template_id)
      )`);
      db.run("ALTER TABLE apps ADD COLUMN environment_id INTEGER REFERENCES environments(id)");
    },
  },
  {
    version: 34,
    description: "Add docker_context column to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN docker_context TEXT NOT NULL DEFAULT '.'");
    },
  },
  {
    version: 35,
    description: "Drop env_templates, app_env_templates, and is_default from environments",
    up: (db) => {
      db.run("DROP TABLE IF EXISTS app_env_templates");
      db.run("DROP TABLE IF EXISTS env_templates");
      // SQLite doesn't support DROP COLUMN before 3.35; recreate the table
      db.run(`CREATE TABLE environments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        env_vars TEXT NOT NULL DEFAULT '{"version":2,"entries":[]}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("INSERT INTO environments_new (id, name, env_vars, created_at) SELECT id, name, env_vars, created_at FROM environments");
      db.run("DROP TABLE environments");
      db.run("ALTER TABLE environments_new RENAME TO environments");
    },
  },
  {
    version: 36,
    description: "Migrate app env_vars into dedicated environments (one app = one environment)",
    up: (db) => {
      const EMPTY_V2 = '{"version":2,"entries":[]}';
      // Get all apps that have non-empty env_vars
      const apps = db.query(
        "SELECT id, name, env_vars, environment_id FROM apps"
      ).all() as Array<{ id: number; name: string; env_vars: string; environment_id: number | null }>;

      for (const app of apps) {
        const hasEnvVars = app.env_vars && app.env_vars !== EMPTY_V2 && app.env_vars !== '{}';
        if (!hasEnvVars && app.environment_id) continue; // already linked, no app vars — skip
        if (!hasEnvVars && !app.environment_id) continue; // no vars at all — skip

        // Pick a unique environment name based on the app name
        let envName = app.name;
        const existing = db.query("SELECT id FROM environments WHERE name = ?").get(envName) as { id: number } | null;
        if (existing && app.environment_id === existing.id && !hasEnvVars) {
          // App already points to an environment with its own name, no app vars to merge
          continue;
        }

        if (hasEnvVars) {
          if (app.environment_id) {
            // App has both environment_id AND app-specific vars — create a new dedicated env merging both
            const envRow = db.query("SELECT env_vars FROM environments WHERE id = ?").get(app.environment_id) as { env_vars: string } | null;
            // Merge: parse both, app vars override environment vars
            const envEntries = parseEntriesFromRaw(envRow?.env_vars);
            const appEntries = parseEntriesFromRaw(app.env_vars);
            const merged = new Map<string, any>();
            for (const e of envEntries) merged.set(e.key, e);
            for (const e of appEntries) merged.set(e.key, e);
            const mergedJson = JSON.stringify({ version: 2, entries: Array.from(merged.values()) });

            // Find unique name
            let dedupName = app.name;
            let suffix = 1;
            while (db.query("SELECT id FROM environments WHERE name = ?").get(dedupName)) {
              dedupName = `${app.name}-${suffix++}`;
            }
            const newEnv = db.query(
              "INSERT INTO environments (name, env_vars) VALUES (?, ?) RETURNING id"
            ).get(dedupName, mergedJson) as { id: number };
            db.run("UPDATE apps SET environment_id = ?, env_vars = ? WHERE id = ?", [newEnv.id, EMPTY_V2, app.id]);
          } else {
            // App has env_vars but no environment — create one
            let dedupName = app.name;
            let suffix = 1;
            while (db.query("SELECT id FROM environments WHERE name = ?").get(dedupName)) {
              dedupName = `${app.name}-${suffix++}`;
            }
            const newEnv = db.query(
              "INSERT INTO environments (name, env_vars) VALUES (?, ?) RETURNING id"
            ).get(dedupName, app.env_vars) as { id: number };
            db.run("UPDATE apps SET environment_id = ?, env_vars = ? WHERE id = ?", [newEnv.id, EMPTY_V2, app.id]);
          }
        }
      }
    },
  },
];

/** Helper for migration 36: parse env var entries from raw JSON. */
function parseEntriesFromRaw(raw: string | null | undefined): Array<{ key: string; [k: string]: any }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2 && Array.isArray(parsed.entries)) return parsed.entries;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => ({
        key, value: String(value), secret: false, updated_at: new Date().toISOString(),
      }));
    }
    return [];
  } catch { return []; }
}

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
    // SQLite requires foreign_keys pragma toggling to happen outside of any
    // active transaction — the runner handles that here on behalf of opt-in
    // migrations.
    if (migration.disableForeignKeys) {
      db.run("PRAGMA foreign_keys = OFF");
    }
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
    } finally {
      if (migration.disableForeignKeys) {
        db.run("PRAGMA foreign_keys = ON");
      }
    }
  }

  log("run", `All migrations applied. Schema now at version ${pending[pending.length - 1].version}`);
}
