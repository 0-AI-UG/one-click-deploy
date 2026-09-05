import type { Database } from "bun:sqlite";
import { initializeProtectionSchema } from "./db/protection-schema.ts";

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
      // the conventional `ocd-panel` app name, with the canonical repository
      // as a fallback. If multiple match, prefer the named panel, then oldest.
      type LegacyApp = { id: number; server_id: number; name: string; domain: string; git_repo: string; webhook_branch?: string; container_port: number; host_port: number; volume_id?: string; volume_mount?: string; env_vars?: string; status?: string; deploy_log?: string; created_at: string };
      const panelApp = db
        .query(
          "SELECT * FROM apps WHERE name = 'ocd-panel' OR git_repo LIKE '%open-cli-deployment%' " +
            "ORDER BY CASE WHEN name = 'ocd-panel' THEN 0 ELSE 1 END, id ASC LIMIT 1",
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

        // Cascade-deletes via FK: deployment_history, replicas,
        // metrics_samples, scaling_events.
        db.query("DELETE FROM apps WHERE id = ?").run(panelApp.id);
      }
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
  {
    version: 37,
    description: "Add services.* and environments.manage permissions, backfill from apps.*",
    up: (db) => {
      const mapping: [string, string][] = [
        ["apps.deploy", "services.deploy"],
        ["apps.restart", "services.manage"],
        ["apps.pause", "services.manage"],
        ["apps.destroy", "services.destroy"],
        ["apps.logs", "services.logs"],
        ["apps.env", "services.link"],
      ];
      for (const [oldPerm, newPerm] of mapping) {
        db.run(
          `INSERT OR IGNORE INTO user_permissions (user_id, permission)
           SELECT user_id, ? FROM user_permissions WHERE permission = ?`,
          [newPerm, oldPerm]
        );
      }
    },
  },
  {
    version: 38,
    description: "Add webhook_wait_for_ci to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_wait_for_ci INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 39,
    description: "Add server_metrics_samples table for server-level CPU/RAM history",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS server_metrics_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        cpu_percent REAL NOT NULL,
        memory_percent REAL NOT NULL,
        sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("CREATE INDEX IF NOT EXISTS idx_server_metrics_server_time ON server_metrics_samples(server_id, sampled_at)");
    },
  },
  {
    version: 40,
    description: "Add public column to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN public INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    version: 41,
    description: "Add extra_volumes column to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN extra_volumes TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 42,
    description: "Add operations and operation_steps tables (engine)",
    up: (db) => {
      db.run(`CREATE TABLE operations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,
        resource_keys   TEXT NOT NULL,
        input_json      TEXT NOT NULL DEFAULT '{}',
        status          TEXT NOT NULL DEFAULT 'pending',
        parent_id       INTEGER REFERENCES operations(id) ON DELETE SET NULL,
        attempt         INTEGER NOT NULL DEFAULT 0,
        scheduled_for   TEXT,
        last_step       TEXT,
        error_json      TEXT,
        trigger         TEXT NOT NULL DEFAULT 'ui',
        triggered_by    TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        enqueued_at     TEXT NOT NULL DEFAULT (datetime('now')),
        started_at      TEXT,
        finished_at     TEXT
      )`);
      db.run(`CREATE TABLE operation_steps (
        op_id       INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        step        TEXT NOT NULL,
        phase       TEXT NOT NULL DEFAULT 'forward',
        status      TEXT NOT NULL,
        output_json TEXT,
        detail      TEXT NOT NULL DEFAULT '',
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        PRIMARY KEY (op_id, seq)
      )`);
      db.run("CREATE INDEX ops_status_sched ON operations(status, scheduled_for)");
      db.run("CREATE INDEX ops_parent ON operations(parent_id)");
      db.run("CREATE UNIQUE INDEX ops_idempotency ON operations(idempotency_key) WHERE idempotency_key IS NOT NULL");
    },
  },
  {
    version: 43,
    description: "Drop legacy deploy_jobs/service_deploy_jobs tables (superseded by operations/operation_steps)",
    up: (db) => {
      // All UI polling has moved to /api/operations/:id/events. The old
      // job tables and their event children are no longer written or read
      // by any code path; drop them along with their FK-bound event tables.
      db.run("DROP TABLE IF EXISTS deploy_job_events");
      db.run("DROP TABLE IF EXISTS deploy_jobs");
      db.run("DROP TABLE IF EXISTS service_deploy_job_events");
      db.run("DROP TABLE IF EXISTS service_deploy_jobs");
    },
  },
  {
    version: 44,
    description: "Add git_branch to apps for branch-specific deployments",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN git_branch TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 45,
    description: "Add token_version to users for session revocation",
    up: (db) => {
      db.run("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 46,
    description: "Persist WebAuthn challenges and device-auth codes to SQLite",
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        challenge TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_kind ON webauthn_challenges(user_id, kind)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at)",
      );

      db.run(`CREATE TABLE IF NOT EXISTS device_auth_codes (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        user_id TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_device_auth_codes_user_code ON device_auth_codes(user_code)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_device_auth_codes_expires ON device_auth_codes(expires_at)",
      );
    },
  },
  {
    version: 47,
    description: "Remove TOTP: drop totp_secret/totp_enabled columns and totp_backup_codes table",
    up: (db) => {
      db.run("DROP TABLE IF EXISTS totp_backup_codes");
      const cols = db.query("PRAGMA table_info(users)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (colNames.has("totp_enabled")) {
        try {
          db.run("ALTER TABLE users DROP COLUMN totp_enabled");
        } catch {
          // Old SQLite fallback handled by the secret-drop branch below
        }
      }
      if (colNames.has("totp_secret")) {
        try {
          db.run("ALTER TABLE users DROP COLUMN totp_secret");
        } catch {
          // ignore
        }
      }
    },
  },
  {
    version: 52,
    description: "service_links: key on environment_id instead of app_id",
    up: (db) => {
      db.run(`CREATE TABLE service_links_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        env_prefix TEXT NOT NULL DEFAULT 'DATABASE',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(service_id, environment_id)
      )`);
      db.run(`
        INSERT OR IGNORE INTO service_links_new (service_id, environment_id, env_prefix, created_at)
        SELECT sl.service_id, a.environment_id, sl.env_prefix, sl.created_at
        FROM service_links sl
        JOIN apps a ON sl.app_id = a.id
        WHERE a.environment_id IS NOT NULL
      `);
      db.run("DROP TABLE service_links");
      db.run("ALTER TABLE service_links_new RENAME TO service_links");
    },
  },
  {
    version: 53,
    description: "Add operation_logs table for per-operation engine log capture",
    up: (db) => {
      db.run(`CREATE TABLE operation_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id   INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        ts      TEXT NOT NULL DEFAULT (datetime('now')),
        level   TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL
      )`);
      db.run("CREATE INDEX op_logs_op_id ON operation_logs(op_id, id)");
    },
  },
  {
    version: 54,
    description: "Add disk usage columns to server_metrics_samples",
    up: (db) => {
      db.run("ALTER TABLE server_metrics_samples ADD COLUMN disk_used_gb REAL NOT NULL DEFAULT 0");
      db.run("ALTER TABLE server_metrics_samples ADD COLUMN disk_total_gb REAL NOT NULL DEFAULT 0");
    },
  },
  {
    version: 55,
    description: "Add per-app memory_mb ceiling to apps (0 = platform default)",
    up: (db) => {
      // 0 means "use the platform default" (DEFAULT_MEM_MB in hetzner/containers).
      // A positive value overrides the container's --memory/--memory-swap ceiling.
      db.run("ALTER TABLE apps ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 56,
    description: "Add deploy_kind to services (container | compose) for multi-container services",
    up: (db) => {
      // "container" = single `docker run` (the existing path). "compose" =
      // multi-container catalog service deployed via a bundled docker-compose
      // template (e.g. Authentik = server + worker + postgresql + redis).
      db.run("ALTER TABLE services ADD COLUMN deploy_kind TEXT NOT NULL DEFAULT 'container'");
    },
  },
  {
    version: 57,
    description: "Drop servers.provider column and provider-selection settings (Hetzner-exclusive)",
    up: (db) => {
      // The provider abstraction was removed — Hetzner is the only provider, so
      // the per-server `provider` column and the compute/dns provider-selection
      // settings no longer vary. DROP COLUMN leaves the table in place, so the
      // ON DELETE CASCADE children of `servers` are untouched (no rebuild needed).
      const cols = db.query("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "provider")) {
        db.run("ALTER TABLE servers DROP COLUMN provider");
      }
      // Settings table may not exist in test fixtures that only create servers + apps.
      const hasSettings = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
      if (hasSettings) {
        db.run(
          "DELETE FROM settings WHERE key IN ('compute_provider', 'dns_provider')",
        );
      }
    },
  },
  {
    version: 58,
    description: "Drop apps deploy_mode/compose_file/compose_web_service columns (Dockerfile-only)",
    up: (db) => {
      // Docker Compose and Railpack app deploy modes were removed — every app
      // now builds from a Dockerfile, so these columns no longer vary. DROP
      // COLUMN leaves the table in place, so the ON DELETE CASCADE children of
      // `apps` are untouched (no rebuild needed). Guarded so re-runs and older
      // fixtures without the columns don't error.
      const cols = db.query("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
      for (const col of ["deploy_mode", "compose_file", "compose_web_service"]) {
        if (cols.some((c) => c.name === col)) {
          db.run(`ALTER TABLE apps DROP COLUMN ${col}`);
        }
      }
    },
  },
  {
    version: 59,
    description: "Add per-app health_check flag to apps (0 = skip HTTP probe, only verify container runs)",
    up: (db) => {
      // 1 = probe http://<bind>:<port>/ after (re)deploys, scale-ups and wakes
      //     (the default, matches historical behavior).
      // 0 = the app doesn't speak HTTP on its exposed port (database, queue
      //     worker) — only verify the container is running.
      db.run("ALTER TABLE apps ADD COLUMN health_check INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    version: 60,
    description: "Add apps.internal_port (fleet-unique, 20000-20199) and backfill",
    up: (db) => {
      // Every app permanently owns one port in the internal ingress block —
      // the block size (200) doubles as the hard fleet app cap. The partial
      // unique index is the concurrency backstop for allocation; a deleted
      // app row frees its port automatically.
      db.run("ALTER TABLE apps ADD COLUMN internal_port INTEGER NOT NULL DEFAULT 0");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_internal_port ON apps(internal_port) WHERE internal_port > 0");
      const apps = db.query("SELECT id FROM apps ORDER BY id ASC").all() as Array<{ id: number }>;
      if (apps.length > 200) throw new Error("More than 200 apps — internal port block 20000-20199 is exhausted");
      apps.forEach((a, i) => db.run("UPDATE apps SET internal_port = ? WHERE id = ?", [20000 + i, a.id]));
    },
  },
  {
    version: 61,
    description: "Blank domains of private apps (no public ingress)",
    up: (db) => {
      db.run("UPDATE apps SET domain = '' WHERE public = 0");
    },
  },
  {
    version: 62,
    description: "Add auth_password_hash (Traefik basicAuth replaces the auth-proxy sidecar)",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN auth_password_hash TEXT NOT NULL DEFAULT ''");
      // Backfill existing password-protected apps. Hashed once here (not at
      // render time): bcrypt salts differ per hash, and the ingress renderer
      // must stay deterministic for its content-hash sync cache.
      const rows = db
        .query("SELECT id, auth_password FROM apps WHERE auth_password != ''")
        .all() as Array<{ id: number; auth_password: string }>;
      for (const row of rows) {
        db.run("UPDATE apps SET auth_password_hash = ? WHERE id = ?", [
          Bun.password.hashSync(row.auth_password, { algorithm: "bcrypt" }),
          row.id,
        ]);
      }
    },
  },
  {
    version: 63,
    description: "Add request-activity columns (last_request_at, requests_per_min) for traffic-based sleep",
    up: (db) => {
      // last_request_at stays NULL until the engine observes the app in
      // Traefik's request counters; the idle monitor seeds it on first
      // evaluation so the sleep window never counts from the epoch.
      db.run("ALTER TABLE apps ADD COLUMN last_request_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN requests_per_min REAL NOT NULL DEFAULT 0");
    },
  },
  {
    version: 64,
    description: "Add per-app ingress settings (sticky, rate_limit_rps, ip_allowlist, health_check_path, compress)",
    up: (db) => {
      // All default to "off" — rendered into Traefik dynamic config only when
      // set, so existing apps' ingress output is byte-identical after this.
      db.run("ALTER TABLE apps ADD COLUMN sticky INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN rate_limit_rps INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN health_check_path TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN compress INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 65,
    description: "Add apps.public_port/public_protocol (raw TCP/UDP exposure on the panel IP)",
    up: (db) => {
      // NULL = not exposed. Ports come from the fleet-wide public pool
      // (30000-30049 tcp, 30050-30099 udp — see PUBLIC_TCP_PORT_BASE); the
      // partial unique index is the allocation concurrency backstop, same
      // pattern as apps.internal_port.
      db.run("ALTER TABLE apps ADD COLUMN public_port INTEGER");
      db.run("ALTER TABLE apps ADD COLUMN public_protocol TEXT NOT NULL DEFAULT 'tcp'");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_public_port ON apps(public_port) WHERE public_port IS NOT NULL");
    },
  },
  {
    version: 66,
    description: "Drop apps.auth_password (auth_password_hash is now the sole source of truth)",
    up: (db) => {
      // The plaintext password was the legacy sidecar-proxy enable-flag and was
      // leaking to the browser. Basic auth is now driven entirely by the bcrypt
      // auth_password_hash (backfilled in migration 62), so the plaintext is
      // dead. DROP COLUMN leaves the table in place — the ON DELETE CASCADE
      // children of `apps` are untouched (no rebuild needed). Guarded so re-runs
      // and older fixtures without the column don't error.
      const cols = db.query("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "auth_password")) {
        db.run("ALTER TABLE apps DROP COLUMN auth_password");
      }
    },
  },
  {
    version: 67,
    description:
      "Add apps.internal_protocol ('http'|'tcp'); backfill from health_check to preserve routing",
    up: (db) => {
      // The internal routing protocol (whether Traefik speaks HTTP or raw TCP
      // on the app's internal entrypoint) used to be implied by the
      // health_check flag: health_check=1 → HTTP router, health_check=0 → TCP.
      // That conflated two independent concerns — HOW we probe the container
      // vs. HOW internal traffic is routed. This column makes routing explicit.
      //
      // Backfill exactly reproduces the old coupling so day-one behavior is
      // byte-identical: 'http' where health_check=1, 'tcp' otherwise.
      db.run("ALTER TABLE apps ADD COLUMN internal_protocol TEXT NOT NULL DEFAULT 'http'");
      db.run("UPDATE apps SET internal_protocol = 'tcp' WHERE health_check = 0");
    },
  },
  {
    version: 68,
    description: "Drop apps.wake_token (the browser wake page is gone; the hold-and-forward waker needs no token)",
    up: (db) => {
      // The wake_token authenticated the old browser wake page's /wake and
      // /wake-status calls. Waking is now transparent: sleeping apps' Traefik
      // routers point at the in-process hold-and-forward waker, which calls
      // wakeApp directly — no token, no page, no polling. The column is dead.
      // Guarded so re-runs and older fixtures without the column don't error.
      const cols = db.query("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "wake_token")) {
        db.run("ALTER TABLE apps DROP COLUMN wake_token");
      }
    },
  },
  {
    version: 69,
    description:
      "Add absolute CPU/memory columns to replicas + service_instances so the UI can show used-of-allowed instead of a bare percentage",
    up: (db) => {
      // cpu_percent/memory_percent stay (the autoscaler compares against them).
      // These add the absolute context the percentage alone can't convey:
      // memory used/limit in MiB (from docker stats MemUsage) and the CPU core
      // ceiling (from docker inspect NanoCpus). Cores used is derived in the UI
      // as cpu_percent/100, so it needs no column. Guarded for re-runs.
      for (const table of ["replicas", "service_instances"]) {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const has = (c: string) => cols.some((col) => col.name === c);
        if (!has("cpu_limit_cores")) db.run(`ALTER TABLE ${table} ADD COLUMN cpu_limit_cores REAL NOT NULL DEFAULT 0`);
        if (!has("memory_used_mb")) db.run(`ALTER TABLE ${table} ADD COLUMN memory_used_mb REAL NOT NULL DEFAULT 0`);
        if (!has("memory_limit_mb")) db.run(`ALTER TABLE ${table} ADD COLUMN memory_limit_mb REAL NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 70,
    description: "Add per-app cpu_limit (fractional cores) to apps (0 = platform default)",
    up: (db) => {
      // 0 means "use the platform default" (DEFAULT_CPUS in hetzner/containers).
      // A positive value overrides the container's --cpus ceiling. Fractional
      // cores are allowed (e.g. 0.5, 2), matching docker's --cpus flag.
      db.run("ALTER TABLE apps ADD COLUMN cpu_limit REAL NOT NULL DEFAULT 0");
    },
  },
  {
    version: 71,
    description: "Add autoscale_req_threshold (target req/min per replica for HTTP request-based scaling; 0 = off)",
    up: (db) => {
      // HPA-style request-rate metric: target requests/min PER REPLICA (same
      // unit as apps.requests_per_min). 0 disables it, leaving CPU/RAM as the
      // only scaling signals. Only applies to HTTP-routed apps — raw-TCP apps
      // have no Traefik request counter.
      db.run("ALTER TABLE apps ADD COLUMN autoscale_req_threshold INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 72,
    description: "Drop services.deploy_kind column (compose deploy path removed — every service is single-container)",
    up: (db) => {
      // Docker Compose catalog services (Authentik, Zitadel) and the whole
      // compose deploy path were removed — every service now runs as a single
      // `docker run` container, so deploy_kind no longer varies. DROP COLUMN
      // leaves the table in place, so the ON DELETE CASCADE children of
      // `services` are untouched. Guarded so re-runs and older fixtures without
      // the column don't error.
      const cols = db.query("PRAGMA table_info(services)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "deploy_kind")) {
        db.run("ALTER TABLE services DROP COLUMN deploy_kind");
      }
    },
  },
  {
    version: 73,
    description: "Add stacks table and apps.stack_id / services.stack_id (multi-app manifest deploys)",
    up: (db) => {
      // A stack groups many apps + managed services deployed from a single
      // ocd-stack.json manifest as one ordered, health-gated unit. environment_id
      // links to the auto-created shared environment members inherit credentials
      // from. Teardown is explicit via the destroy_stack op, so no ON DELETE
      // CASCADE is needed here. stack_id on apps/services is nullable — members
      // not belonging to a stack keep it NULL, mirroring apps.environment_id.
      db.run(`CREATE TABLE IF NOT EXISTS stacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        environment_id INTEGER,
        status TEXT NOT NULL DEFAULT 'deploying',
        deploy_log TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("ALTER TABLE apps ADD COLUMN stack_id INTEGER");
      db.run("ALTER TABLE services ADD COLUMN stack_id INTEGER");
    },
  },
  {
    version: 74,
    description:
      "Add volume_attached flag to apps + service_instances (distinguish a created volume from an attached-existing one for safe destroy)",
    up: (db) => {
      // 0 = managed/created by us (safe to DELETE on destroy).
      // 1 = an EXISTING volume ATTACHED via attach_existing_volume (predates us,
      //     may hold data owned by something else — DETACH only, never delete).
      // Default 0 backfills every existing row to today's semantics (delete on
      // destroy), so no already-deployed app changes meaning. Only volumes
      // attached going forward via attach_existing_volume are marked 1.
      db.run("ALTER TABLE apps ADD COLUMN volume_attached INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE service_instances ADD COLUMN volume_attached INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 75,
    description:
      "Add action_confirmations table (browser-gated confirmation of destructive CLI actions, mirrors device_auth_codes)",
    up: (db) => {
      // A pending confirmation is created by an already-authenticated CLI, then
      // approved or denied by the user in the web UI, and polled for the result
      // by the CLI. confirm_code is the CLI's private handle (UUID); user_code is
      // the short human-typable code shown in the browser. Rows are short-lived
      // (10 min TTL) and deleted once resolved and polled.
      db.run(`CREATE TABLE IF NOT EXISTS action_confirmations (
        confirm_code TEXT PRIMARY KEY,
        user_code    TEXT NOT NULL UNIQUE,
        user_id      TEXT NOT NULL,
        action       TEXT NOT NULL,
        summary      TEXT NOT NULL,
        status       TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      )`);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_action_confirmations_user_code ON action_confirmations(user_code)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_action_confirmations_expires ON action_confirmations(expires_at)",
      );
    },
  },
  {
    version: 76,
    description:
      "Bind action_confirmations to a specific resource (resource_type + resource_id) so a browser-approved confirmation can only be consumed to destroy the exact resource it was created for",
    up: (db) => {
      // Migration 75 already ran in dev, so ALTER the existing table rather than
      // recreating it. Defaults let any (none should exist) in-flight pending
      // rows keep a valid, non-null shape.
      db.run("ALTER TABLE action_confirmations ADD COLUMN resource_type TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE action_confirmations ADD COLUMN resource_id TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 77,
    description:
      "Add placement/durability foundation: servers.pool + apps.{durability_class,max_per_host,min_locations,placement_pool,env_label,sibling_of} + availability_samples table. Every default backfills already-deployed rows to today's exact behaviour: servers land in the 'general' pool, apps declare durability_class 'none' (no availability target), max_per_host 0 (unlimited replicas per host = today's soft affinity), min_locations 1 (no spread requirement), placement_pool 'general' (schedulable on the default pool), env_label '' (no cosmetic env), and sibling_of NULL (not a staging/dev sibling). So no existing app or server changes meaning.",
    up: (db) => {
      // servers.pool: named capacity pool a server belongs to. Default 'general'
      // so every existing server stays in the single implicit pool apps schedule
      // onto today — placement is unchanged until an app opts into another pool.
      db.run("ALTER TABLE servers ADD COLUMN pool TEXT NOT NULL DEFAULT 'general'");

      // apps.durability_class: intent label 'none' | 'standard' | 'high'. 'none'
      // preserves current behaviour (no availability target enforced/sampled).
      db.run("ALTER TABLE apps ADD COLUMN durability_class TEXT NOT NULL DEFAULT 'none'");
      // apps.max_per_host: hard cap of this app's replicas per host. 0 = unlimited
      // (today's soft-affinity spread); >0 = hard cap enforced by placement.
      db.run("ALTER TABLE apps ADD COLUMN max_per_host INTEGER NOT NULL DEFAULT 0");
      // apps.min_locations: minimum distinct provider locations replicas must span.
      // 1 = no spread requirement (today's behaviour).
      db.run("ALTER TABLE apps ADD COLUMN min_locations INTEGER NOT NULL DEFAULT 1");
      // apps.placement_pool: which servers.pool this app's replicas may land on.
      // 'general' matches the default server pool, so scheduling is unchanged.
      db.run("ALTER TABLE apps ADD COLUMN placement_pool TEXT NOT NULL DEFAULT 'general'");
      // apps.env_label: cosmetic env tag '' | 'production' | 'staging' | 'dev'.
      // '' = untagged (today's behaviour); purely a display concern.
      db.run("ALTER TABLE apps ADD COLUMN env_label TEXT NOT NULL DEFAULT ''");
      // apps.sibling_of: nullable id of the prod app this is a staging/dev sibling
      // of. NULL = standalone app (today's behaviour); no self-reference for
      // existing rows.
      db.run("ALTER TABLE apps ADD COLUMN sibling_of INTEGER");

      // availability_samples: periodic snapshots of whether an app met its
      // durability/availability target, used to compute uptime% and MTTR. Cascades
      // on app delete. sampled_at defaults to now so inserts need not pass it.
      db.run(`CREATE TABLE IF NOT EXISTS availability_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        meets_target INTEGER NOT NULL,
        desired_count INTEGER NOT NULL,
        running_count INTEGER NOT NULL,
        distinct_hosts INTEGER NOT NULL,
        distinct_locations INTEGER NOT NULL,
        sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_availability_samples_app ON availability_samples(app_id, sampled_at)",
      );
    },
  },
  {
    version: 78,
    description: "Add apps.virtual_ip (fleet-unique per-app VIP in 10.96.0.0/16) and backfill",
    up: (db) => {
      // Every app permanently owns one address in the VIP block (10.96.0.1 -
      // 10.96.255.254; .0.0 and .255.255 are the network/broadcast addresses).
      // The partial unique index is the concurrency backstop for allocation; a
      // deleted app row frees its VIP automatically.
      db.run("ALTER TABLE apps ADD COLUMN virtual_ip TEXT NOT NULL DEFAULT ''");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_virtual_ip ON apps(virtual_ip) WHERE virtual_ip != ''");
      const apps = db.query("SELECT id FROM apps ORDER BY id ASC").all() as Array<{ id: number }>;
      apps.forEach((a, i) => {
        const index = i + 1;
        db.run("UPDATE apps SET virtual_ip = ? WHERE id = ?", [
          `10.96.${Math.floor(index / 256)}.${index % 256}`,
          a.id,
        ]);
      });
    },
  },
  {
    version: 79,
    description:
      "Rewrite stored plaintext env-var URLs pointing at the removed Traefik internal entrypoints (`http|tcp://<app>.ocd.internal:<internal_port>`) to the canonical VIP-proxy forms: `http://<app>.ocd.internal` for HTTP apps, `tcp://<app>.ocd.internal:<container_port>` for TCP apps",
    up: (db) => {
      // Stack `needs` injection wrote these values in plaintext into
      // environments.env_vars, and they only refresh on a stack redeploy —
      // rewrite them in place. Only exact plaintext matches are touched;
      // encrypted (secret) entries are left alone.
      const apps = db
        .query("SELECT name, internal_port, internal_protocol, container_port FROM apps")
        .all() as Array<{
        name: string;
        internal_port: number;
        internal_protocol: string;
        container_port: number;
      }>;
      const canonical = new Map<string, string>();
      for (const a of apps) {
        const host = `${a.name}.ocd.internal`;
        const target =
          a.internal_protocol === "tcp"
            ? `tcp://${host}:${a.container_port}`
            : `http://${host}`;
        canonical.set(`http://${host}:${a.internal_port}`, target);
        canonical.set(`tcp://${host}:${a.internal_port}`, target);
      }
      if (canonical.size === 0) return;

      const envs = db.query("SELECT id, env_vars FROM environments").all() as Array<{
        id: number;
        env_vars: string;
      }>;
      for (const env of envs) {
        let parsed: { version?: number; entries?: Array<Record<string, unknown>> };
        try {
          parsed = JSON.parse(env.env_vars);
        } catch {
          continue;
        }
        if (parsed?.version !== 2 || !Array.isArray(parsed.entries)) continue;
        let changed = false;
        for (const entry of parsed.entries) {
          if (entry.secret) continue;
          const next = canonical.get(String(entry.value));
          if (next !== undefined && next !== entry.value) {
            entry.value = next;
            changed = true;
          }
        }
        if (changed) {
          db.run("UPDATE environments SET env_vars = ? WHERE id = ?", [
            JSON.stringify(parsed),
            env.id,
          ]);
        }
      }
    },
  },
  {
    version: 80,
    description:
      "Rename apps.env_label -> apps.target and apps.sibling_of -> apps.target_of. The 'stage' axis (production/staging/dev) is now called a deploy 'target' throughout, freeing the word 'environment' to mean only the env-var bag (the environments table). Pure column rename: values and semantics are unchanged.",
    up: (db) => {
      // SQLite (>=3.25, bun:sqlite) supports RENAME COLUMN in place — no table
      // rebuild, indexes/data preserved. Both columns were added in migration 77.
      db.run("ALTER TABLE apps RENAME COLUMN env_label TO target");
      db.run("ALTER TABLE apps RENAME COLUMN sibling_of TO target_of");
    },
  },
  {
    version: 81,
    description:
      "Add apps.webhook_staging. When set, a webhook push deploys to the app's hidden <name>-staging sibling and holds; production is swapped only when the user clicks Promote. When unset (default), webhook pushes redeploy production directly.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_staging INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 82,
    description:
      "Add apps.webhook_staging_environment_id. Webhook staging now deploys the sibling with an EXPLICITLY selected environment instead of live-inheriting production's env. Migrate existing staging apps: freeze each sibling's effective env (production overlaid by the sibling's override env) into the sibling's own environment row, then point the production app's webhook_staging_environment_id at it — preserving behavior without live inheritance.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_staging_environment_id INTEGER");

      // Freeze live-inherited staging envs into explicit ones. For each prod app
      // that had staging on, merge production's env (base) under the sibling's
      // override env (wins) and persist that into the sibling's environment row,
      // then wire the prod app to it. Ciphertext entries merge by key, so no
      // decryption is needed.
      const prods = db
        .query("SELECT id, environment_id, name FROM apps WHERE webhook_staging = 1 AND (target = '' OR target = 'production')")
        .all() as Array<{ id: number; environment_id: number | null; name: string }>;
      for (const prod of prods) {
        const sibling = db
          .query("SELECT id, environment_id FROM apps WHERE target_of = ? AND target = 'staging' ORDER BY created_at ASC LIMIT 1")
          .get(prod.id) as { id: number; environment_id: number | null } | undefined;

        if (!sibling) {
          // No sibling deployed yet — point staging at production's own env so the
          // next push deploys with an explicit environment (NULL if prod has none).
          db.run("UPDATE apps SET webhook_staging_environment_id = ? WHERE id = ?", [prod.environment_id, prod.id]);
          continue;
        }

        const baseRow = prod.environment_id
          ? (db.query("SELECT env_vars FROM environments WHERE id = ?").get(prod.environment_id) as { env_vars: string } | undefined)
          : undefined;
        const overRow = sibling.environment_id
          ? (db.query("SELECT env_vars FROM environments WHERE id = ?").get(sibling.environment_id) as { env_vars: string } | undefined)
          : undefined;
        const merged = serializeMergedEntries(
          parseEntriesFromRaw(baseRow?.env_vars),
          parseEntriesFromRaw(overRow?.env_vars),
        );

        let envId = sibling.environment_id;
        if (envId) {
          db.run("UPDATE environments SET env_vars = ? WHERE id = ?", [merged, envId]);
        } else {
          const nameRow = db.query("SELECT name FROM apps WHERE id = ?").get(sibling.id) as { name: string };
          const created = db
            .query("INSERT INTO environments (name, env_vars) VALUES (?, ?) RETURNING id")
            .get(nameRow.name, merged) as { id: number };
          envId = created.id;
          db.run("UPDATE apps SET environment_id = ? WHERE id = ?", [envId, sibling.id]);
        }
        db.run("UPDATE apps SET webhook_staging_environment_id = ? WHERE id = ?", [envId, prod.id]);
      }
    },
  },
  {
    version: 83,
    description:
      "Add stacks.staging_environment_id — a stack's shared staging environment. Members that opt into webhook staging (webhook.staging in their own manifest) deploy their <member>-staging sibling with this environment, unless that member carries an explicit per-app override in apps.webhook_staging_environment_id. The per-app column stays the backend source of truth; this is the stack-level default pushed down to members on every deploy.",
    up: (db) => {
      db.run("ALTER TABLE stacks ADD COLUMN staging_environment_id INTEGER");
    },
  },
  {
    version: 84,
    description:
      "Add apps.stack_needs — the member's `needs` edges from its stack manifest, JSON-encoded as an array of member keys (NULL for apps that are not stack members, or that were deployed before this column existed). Until now these edges were consumed once at deploy time to topo-sort members into levels and then thrown away, so nothing downstream could order members by dependency. Persisting them lets promote_stack (and any later stack-wide op) promote level by level instead of all at once, which is what keeps interdependent members from briefly running mismatched versions.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN stack_needs TEXT");
    },
  },
  {
    version: 85,
    description:
      "Scope user_permissions to a resource and split the coarse permissions. Adds (scope_type, scope_id) so a grant can apply fleet-wide, to one environment, or to one app — the UNIQUE key has to include the scope, which SQLite cannot alter in place, so the table is rebuilt. Old grants are carried over as global and widened into the permissions they were split into (e.g. servers.view was the de facto read-everything grant and becomes the six read permissions), so nobody loses access on upgrade. apps.env and volumes.manage are dropped: the former was never enforced anywhere, the latter is superseded by volumes.attach/detach/resize.",
    up: (db) => {
      db.run(`CREATE TABLE user_permissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        scope_type TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT,
        UNIQUE(user_id, permission, scope_type, scope_id)
      )`);
      // Skip rows whose user no longer exists. The old table declared the same
      // FK but was populated while enforcement was off, so deleting a user left
      // its grants behind; carrying those over trips SQLITE_CONSTRAINT_FOREIGNKEY
      // and fails the whole migration. Dropping them is what the FK's ON DELETE
      // CASCADE would have done at the time.
      db.run(
        `INSERT OR IGNORE INTO user_permissions_new (user_id, permission, scope_type, scope_id)
         SELECT user_id, permission, 'global', NULL FROM user_permissions
         WHERE user_id IN (SELECT id FROM users)`,
      );
      db.run("DROP TABLE user_permissions");
      db.run("ALTER TABLE user_permissions_new RENAME TO user_permissions");

      // old permission -> permissions it was split into. The old name is kept
      // wherever it still exists in the new catalog; where it does not (left
      // column absent from the right), the migration below deletes it.
      const widen: [string, string[]][] = [
        ["servers.view", ["fleet.view", "apps.view", "services.view", "environments.view", "metrics.view", "operations.view"]],
        ["servers.delete", ["servers.delete", "servers.manage"]],
        ["resources.create", ["servers.create"]],
        ["apps.deploy", ["apps.deploy", "apps.promote"]],
        ["apps.redeploy", ["apps.deploy", "panel.manage"]],
        ["apps.logs", ["apps.logs", "deployments.view", "panel.view"]],
        ["stacks.deploy", ["stacks.deploy", "stacks.promote"]],
        ["scaling.manage", ["apps.deploy", "scaling.migrate"]],
        ["volumes.manage", ["volumes.attach", "volumes.detach", "volumes.resize"]],
        ["terminal.access", ["terminal.container", "terminal.host"]],
        ["environments.manage", ["environments.manage", "environments.secrets"]],
      ];
      for (const [oldPerm, newPerms] of widen) {
        for (const newPerm of newPerms) {
          db.run(
            `INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id)
             SELECT user_id, ?, 'global', NULL FROM user_permissions WHERE permission = ? AND scope_type = 'global'`,
            [newPerm, oldPerm],
          );
        }
      }

      // Everyone who could already reach the API keeps CLI access; it is a new
      // restriction, not a new capability, so opting existing users in is right.
      db.run(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id)
         SELECT id, 'cli.access', 'global', NULL FROM users`,
      );

      // Names that no longer exist in ALL_PERMISSIONS.
      const retired = [
        "servers.view",
        "apps.env",
        "apps.redeploy",
        "scaling.manage",
        "volumes.manage",
        "terminal.access",
        "resources.create",
      ];
      for (const perm of retired) {
        db.run("DELETE FROM user_permissions WHERE permission = ?", [perm]);
      }
    },
  },
  {
    version: 86,
    description:
      "Add apps.env_projection. NULL preserves the legacy behavior (receive every variable from the linked environment); a JSON array limits a stack member to explicitly selected keys, including [] for platform variables only.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN env_projection TEXT");
    },
  },
  {
    version: 87,
    description:
      "Track app containers whose linked environment changed after they were created, and retain detached managed volumes in a recoverable retired_volumes registry instead of deleting them immediately.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN environment_stale INTEGER NOT NULL DEFAULT 0");
      db.run(`CREATE TABLE retired_volumes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_volume_id TEXT NOT NULL UNIQUE,
        former_resource_type TEXT NOT NULL,
        former_resource_id INTEGER NOT NULL,
        former_resource_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'detached',
        retired_at TEXT NOT NULL DEFAULT (datetime('now')),
        purge_after TEXT NOT NULL DEFAULT (datetime('now', '+7 days'))
      )`);
    },
  },
  {
    version: 88,
    description:
      "Version the desired app configuration separately from source deployments, retain provenance for the last explicitly applied manifest, and snapshot the configuration revision in deployment history.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE apps ADD COLUMN last_manifest_path TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_manifest_hash TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_manifest_applied_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_manifest_config_revision INTEGER");
      db.run("ALTER TABLE deployment_history ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1");
      // Every user-controlled runtime/build field writes through the apps row,
      // whether the caller is the UI, CLI manifest apply, stack reconciler, or
      // an operational endpoint. Keeping the revision bump in SQLite prevents
      // one of those paths from silently escaping provenance.
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          volume_id, volume_mount, extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET config_revision = config_revision + 1 WHERE id = NEW.id;
        END`);
      // Environment values are desired runtime configuration too. Because an
      // environment may be shared, one edit advances every linked app (and a
      // parent whose webhook-staging environment points at it).
      db.run(`CREATE TRIGGER environments_bump_linked_app_config_revision
        AFTER UPDATE OF env_vars ON environments
        BEGIN
          UPDATE apps
          SET config_revision = config_revision + 1
          WHERE environment_id = NEW.id
             OR webhook_staging_environment_id = NEW.id;
        END`);
    },
  },
  {
    version: 89,
    description:
      "Soft-delete environments for seven-day recovery instead of permanently removing them immediately.",
    up: (db) => {
      db.run("ALTER TABLE environments ADD COLUMN deleted_at TEXT");
      db.run("ALTER TABLE environments ADD COLUMN purge_after TEXT");
      db.run("CREATE INDEX idx_environments_deleted_at ON environments(deleted_at)");
    },
  },
  {
    version: 90,
    description:
      "Audit permanent provider-volume deletion and add the dedicated volume rename permission.",
    up: (db) => {
      db.run(`CREATE TABLE volume_deletion_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT NOT NULL,
        provider_volume_id TEXT NOT NULL,
        provider_volume_name TEXT NOT NULL,
        former_resource_type TEXT NOT NULL DEFAULT '',
        former_resource_id INTEGER NOT NULL DEFAULT 0,
        former_resource_name TEXT NOT NULL DEFAULT '',
        retention_state TEXT NOT NULL DEFAULT '',
        retired_at TEXT,
        purge_after TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      db.run(
        "CREATE INDEX idx_volume_deletion_audit_provider ON volume_deletion_audit(provider_volume_id, requested_at)",
      );
      // Existing users trusted to resize provider volumes may also rename
      // their metadata; this preserves behavior when the finer grant appears.
      db.run(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id)
         SELECT user_id, 'volumes.rename', scope_type, scope_id
         FROM user_permissions WHERE permission = 'volumes.resize'`,
      );
    },
  },
  {
    version: 91,
    description:
      "Add immutable OCI artifact deployments, registry-backed source-build cache configuration, truthful workload health contracts, and deployed image digest history.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'git'");
      db.run("ALTER TABLE apps ADD COLUMN image_ref TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN build_cache_ref TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN health_check_mode TEXT NOT NULL DEFAULT 'http'");
      db.run("ALTER TABLE apps ADD COLUMN health_check_command TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN health_check_file TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN health_check_max_age_seconds INTEGER NOT NULL DEFAULT 0");
      db.run("UPDATE apps SET health_check_mode = CASE WHEN health_check = 0 THEN 'container' ELSE 'http' END");
      db.run("ALTER TABLE deployment_history ADD COLUMN image_digest TEXT NOT NULL DEFAULT ''");

      // Recreate the revision trigger so changes to artifact identity, shared
      // build cache, or the readiness contract are versioned desired config.
      db.run("DROP TRIGGER apps_bump_config_revision");
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          source_mode, image_ref, build_cache_ref,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, health_check_mode, health_check_command,
          health_check_file, health_check_max_age_seconds,
          internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          volume_id, volume_mount, extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET config_revision = config_revision + 1 WHERE id = NEW.id;
        END`);
    },
  },
  {
    version: 92,
    description:
      "Remove obsolete app settings, ingress, webhook, scaling-policy, manual-scale, and stack-settings grants after consolidating desired configuration under deploy.",
    up: (db) => {
      db.run(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id)
         SELECT user_id, 'apps.deploy', 'global', NULL
         FROM user_permissions
         WHERE scope_type = 'global'
           AND permission IN (
             'apps.redeploy',
             'apps.ingress',
             'apps.expose',
             'webhooks.manage',
             'scaling.scale',
             'scaling.policy'
           )`,
      );
      db.run(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id)
         SELECT user_id, 'stacks.deploy', 'global', NULL
         FROM user_permissions
         WHERE scope_type = 'global' AND permission = 'stacks.settings'`,
      );
      db.run(
        `DELETE FROM user_permissions
         WHERE permission IN (
           'apps.redeploy',
           'apps.ingress',
           'apps.expose',
           'webhooks.manage',
           'scaling.scale',
           'scaling.policy',
           'stacks.settings'
         )`,
      );
    },
  },
  {
    version: 93,
    description:
      "Classify retained volumes so expired failed-deploy artifacts can be cleaned automatically without touching user-retained data.",
    up: (db) => {
      db.run("ALTER TABLE retired_volumes ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'user'");
    },
  },
  {
    version: 94,
    description:
      "Persist per-replica deployment attestations, environment hashes, operation-log attempts, and transactional host-port reservations.",
    up: (db) => {
      db.run("ALTER TABLE deployment_history ADD COLUMN env_hash TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE replicas ADD COLUMN image_digest TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE replicas ADD COLUMN desired_image_digest TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE replicas ADD COLUMN env_hash TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE replicas ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE replicas ADD COLUMN attested_at TEXT");
      db.run("ALTER TABLE replicas ADD COLUMN attestation_error TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE operation_logs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
      db.run("ALTER TABLE apps ADD COLUMN public_endpoint_status TEXT NOT NULL DEFAULT 'unknown'");
      db.run("ALTER TABLE apps ADD COLUMN public_endpoint_error TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN public_endpoint_checked_at TEXT");
      db.run(`CREATE TABLE port_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        bind_address TEXT NOT NULL,
        host_port INTEGER NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'tcp',
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(server_id, bind_address, host_port, protocol)
      )`);
      db.run("CREATE INDEX idx_port_reservations_owner ON port_reservations(owner_type, owner_id)");
    },
  },
  {
    version: 95,
    description:
      "Persist reconciler observations, deferred GC/rollout/deletion intents, and panel webhook ownership.",
    up: (db) => {
      db.run("ALTER TABLE servers ADD COLUMN provider_status TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE servers ADD COLUMN last_observed_at TEXT");
      db.run("ALTER TABLE servers ADD COLUMN unavailable_ticks INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE servers ADD COLUMN gc_requested_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN rollout_requested_revision INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN rollout_requested_after_deployment_id INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN deletion_requested_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN github_webhook_repo TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE services ADD COLUMN deletion_requested_at TEXT");
      db.run("ALTER TABLE panel ADD COLUMN webhook_owner_user_id TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE panel ADD COLUMN github_webhook_repo TEXT NOT NULL DEFAULT ''");
      db.run("UPDATE apps SET github_webhook_repo = git_repo WHERE github_webhook_id <> ''");
      db.run("UPDATE panel SET github_webhook_repo = git_repo WHERE github_webhook_id <> ''");
      // When a caller declares rollout intent before applying configuration,
      // keep that intent pointed at the newest revision produced by the apply.
      // This closes the apply->enqueue crash window without making deploy=false
      // configuration changes roll out implicitly.
      db.run("DROP TRIGGER apps_bump_config_revision");
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          source_mode, image_ref, build_cache_ref,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, health_check_mode, health_check_command,
          health_check_file, health_check_max_age_seconds,
          internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          volume_id, volume_mount, extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE id = NEW.id;
        END`);
      db.run("DROP TRIGGER environments_bump_linked_app_config_revision");
      db.run(`CREATE TRIGGER environments_bump_linked_app_config_revision
        AFTER UPDATE OF env_vars ON environments
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE environment_id = NEW.id
             OR webhook_staging_environment_id = NEW.id;
        END`);
    },
  },
  {
    version: 96,
    description:
      "Enforce CLI-only manifest deployment by removing obsolete browser deploy drafts and app rename authorization.",
    up: (db) => {
      db.run("DROP TABLE IF EXISTS deploy_sessions");
      db.run("DELETE FROM user_permissions WHERE permission = 'apps.rename'");
      db.run(`UPDATE operations
        SET status = 'failed',
            error_json = '{"message":"App rename was removed; app identity is manifest-owned"}',
            finished_at = datetime('now')
        WHERE kind = 'rename_app' AND status IN ('pending', 'running', 'compensating')`);
    },
  },
  {
    version: 97,
    description:
      "Make primary app volume state manifest-owned and remove direct volume mutation authorization.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN desired_volume_id TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE apps ADD COLUMN desired_volume_size INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE apps ADD COLUMN desired_volume_path TEXT NOT NULL DEFAULT '/data'");
      // Preserve legacy attachments without guessing provider size. Their next
      // required manifest apply replaces -1 with explicit desired state.
      db.run(`UPDATE apps
        SET desired_volume_id = volume_id,
            desired_volume_size = -1,
            desired_volume_path = CASE
              WHEN instr(volume_mount, ':') > 0 THEN substr(volume_mount, instr(volume_mount, ':') + 1)
              ELSE '/data'
            END
        WHERE volume_id <> ''`);
      db.run(
        "DELETE FROM user_permissions WHERE permission IN ('volumes.create','volumes.attach','volumes.detach','volumes.resize','volumes.rename')",
      );
      // Actual attachment fields are observed runtime state. Only desired
      // volume fields belong in configuration revision identity.
      db.run("DROP TRIGGER apps_bump_config_revision");
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          source_mode, image_ref, build_cache_ref,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, health_check_mode, health_check_command,
          health_check_file, health_check_max_age_seconds,
          internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          desired_volume_id, desired_volume_size, desired_volume_path,
          extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE id = NEW.id;
      END`);
    },
  },
  {
    version: 98,
    description:
      "Track managed-service deploy targets, production/staging relationships and placement pools, plus explicitly staging-owned environment keys.",
    up: (db) => {
      // Keep these as explicit service properties rather than inferring them
      // from names. A staging service owns persistent data, so reconciliation
      // and teardown must be able to distinguish it from an unrelated service
      // that happens to end in "-staging".
      db.run("ALTER TABLE services ADD COLUMN target TEXT NOT NULL DEFAULT 'production'");
      db.run("ALTER TABLE services ADD COLUMN target_of INTEGER");
      db.run("ALTER TABLE services ADD COLUMN placement_pool TEXT NOT NULL DEFAULT 'general'");
      db.run("CREATE UNIQUE INDEX services_target_of_target ON services(target_of, target) WHERE target_of IS NOT NULL");
      // Certification prevents a copied production key from satisfying a
      // staging_env `required` declaration before an explicit staging value
      // has ever been applied for that key.
      db.run("ALTER TABLE stacks ADD COLUMN staging_env_keys TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 99,
    description: "Store exact HTTP readiness status contracts for apps.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN health_check_expected_statuses TEXT NOT NULL DEFAULT '[200]'");
      db.run("DROP TRIGGER apps_bump_config_revision");
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          source_mode, image_ref, build_cache_ref,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, health_check_mode, health_check_command,
          health_check_file, health_check_max_age_seconds, health_check_expected_statuses,
          internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          desired_volume_id, desired_volume_size, desired_volume_path,
          extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE id = NEW.id;
      END`);
    },
  },
  {
    version: 100,
    description:
      "Add change-aware stack webhook filters, manifest provenance, durable push candidates, and decision observations.",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN webhook_paths TEXT");
      db.run("ALTER TABLE apps ADD COLUMN webhook_paths_ignore TEXT NOT NULL DEFAULT '[]'");
      db.run("ALTER TABLE apps ADD COLUMN manifest_path TEXT");
      db.run("ALTER TABLE apps ADD COLUMN stack_manifest_path TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_webhook_head TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_webhook_decision TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_webhook_received_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_webhook_evaluated_at TEXT");
      db.run("ALTER TABLE apps ADD COLUMN last_webhook_ci_result TEXT");
      db.run("UPDATE apps SET manifest_path = last_manifest_path WHERE last_manifest_path IS NOT NULL");
      db.run(
        `UPDATE apps
         SET webhook_paths = json_array(webhook_path || '/**')
         WHERE webhook_path <> ''`,
      );
      db.run(`CREATE TABLE webhook_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        branch TEXT NOT NULL,
        before_sha TEXT NOT NULL DEFAULT '',
        head_sha TEXT NOT NULL,
        origin_app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        stack_id INTEGER,
        delivery_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        ci_result TEXT,
        parent_operation_id INTEGER,
        superseded_by_head TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repository, branch, head_sha)
      )`);
      db.run("CREATE INDEX webhook_candidates_repo_branch ON webhook_candidates(repository, branch, id DESC)");

      db.run("DROP TRIGGER apps_bump_config_revision");
      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, git_repo, git_branch, dockerfile_path, docker_context,
          source_mode, image_ref, build_cache_ref,
          container_port, auth_password_hash, environment_id, env_projection,
          public, health_check, health_check_mode, health_check_command,
          health_check_file, health_check_max_age_seconds, health_check_expected_statuses,
          internal_protocol, sticky, rate_limit_rps,
          ip_allowlist, health_check_path, compress, public_port,
          public_protocol, desired_replicas, min_replicas, max_replicas,
          autoscale_enabled, autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          desired_volume_id, desired_volume_size, desired_volume_path,
          extra_volumes, memory_mb, cpu_limit,
          webhook_enabled, webhook_branch, webhook_path, webhook_paths,
          webhook_paths_ignore, webhook_wait_for_ci,
          webhook_staging_environment_id, durability_class, max_per_host,
          min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE id = NEW.id;
        END`);
    },
  },
  {
    version: 101,
    description: "Persist deployment image, archive, and transfer sizes",
    up: (db) => {
      db.run("ALTER TABLE deployment_history ADD COLUMN image_size_bytes INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE deployment_history ADD COLUMN archive_size_bytes INTEGER NOT NULL DEFAULT 0");
      db.run("ALTER TABLE deployment_history ADD COLUMN transfer_size_bytes INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 102,
    description: "Make engine deployment-history writes idempotent per operation",
    up: (db) => {
      db.run("ALTER TABLE deployment_history ADD COLUMN operation_id INTEGER");
      db.run(
        "CREATE UNIQUE INDEX deployment_history_operation_id_unique " +
        "ON deployment_history(operation_id) WHERE operation_id IS NOT NULL",
      );
    },
  },
  {
    version: 103,
    description: "Make engine scaling-event writes idempotent per operation",
    up: (db) => {
      db.run("ALTER TABLE scaling_events ADD COLUMN operation_id INTEGER");
      db.run(
        "CREATE UNIQUE INDEX scaling_events_operation_id_unique " +
        "ON scaling_events(operation_id) WHERE operation_id IS NOT NULL",
      );
    },
  },
  {
    version: 104,
    description: "Separate server runtime identity from infrastructure ownership",
    up: (db) => {
      db.run("ALTER TABLE servers ADD COLUMN provider TEXT NOT NULL DEFAULT 'external'");
      db.run("ALTER TABLE servers ADD COLUMN ownership TEXT NOT NULL DEFAULT 'connected'");
      db.run("ALTER TABLE servers ADD COLUMN management_address TEXT NOT NULL DEFAULT ''");
      db.run("ALTER TABLE servers ADD COLUMN ssh_user TEXT NOT NULL DEFAULT 'root'");
      db.run("ALTER TABLE servers ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22");
      // Rows created by previous OCD versions are provider-created Hetzner
      // machines. This is a data classification, not a compatibility mode.
      db.run("UPDATE servers SET provider = 'hetzner', ownership = 'managed', management_address = ipv4");
      db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_domain_suffix', '')");
      db.run(
        "DELETE FROM settings WHERE key IN ('compute_provider', 'dns_provider', 'dns_zone_id', 'dns_zone_name', 'provider_token')",
      );
    },
  },
  {
    version: 105,
    description: "Remove source-build and webhook state; make immutable images the only deployment source",
    disableForeignKeys: true,
    up: (db) => {
      const immutableImage = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;
      const apps = db.query("SELECT id, name, image_ref FROM apps").all() as Array<{
        id: number;
        name: string;
        image_ref: string;
      }>;
      const invalidApp = apps.find((app) => !immutableImage.test(app.image_ref));
      if (invalidApp) {
        throw new Error(
          `App ${invalidApp.name} (${invalidApp.id}) has no immutable image_ref; publish and record an @sha256 image before upgrading`,
        );
      }

      const panel = db.query("SELECT id FROM panel WHERE id = 1").get() as { id: number } | null;
      let panelImage = "";
      if (panel) {
        const deployment = db.query(
          "SELECT image_tag FROM panel_deployments WHERE status = 'deployed' ORDER BY created_at DESC, id DESC LIMIT 1",
        ).get() as { image_tag: string } | null;
        panelImage = deployment?.image_tag ?? "";
        if (!immutableImage.test(panelImage)) {
          throw new Error(
            "The panel has no immutable deployed image; record an @sha256 panel deployment before upgrading",
          );
        }
      }

      db.run("DROP TRIGGER IF EXISTS apps_bump_config_revision");
      db.run("DROP TRIGGER IF EXISTS environments_bump_linked_app_config_revision");
      db.run("DROP TABLE IF EXISTS webhook_candidates");
      db.run("DELETE FROM settings WHERE key IN ('oci_cache_ref', 'allow_archive_image_transfer')");

      for (const column of [
        "git_repo",
        "git_branch",
        "dockerfile_path",
        "docker_context",
        "source_mode",
        "build_cache_ref",
        "webhook_enabled",
        "webhook_secret",
        "webhook_branch",
        "webhook_path",
        "webhook_paths",
        "webhook_paths_ignore",
        "github_webhook_id",
        "webhook_wait_for_ci",
        "webhook_staging",
        "webhook_staging_environment_id",
        "last_webhook_head",
        "last_webhook_decision",
        "last_webhook_received_at",
        "last_webhook_evaluated_at",
        "last_webhook_ci_result",
        "github_webhook_repo",
      ]) {
        db.run(`ALTER TABLE apps DROP COLUMN ${column}`);
      }

      db.run("ALTER TABLE panel ADD COLUMN image_ref TEXT NOT NULL DEFAULT ''");
      if (panel) db.run("UPDATE panel SET image_ref = ? WHERE id = 1", [panelImage]);
      for (const column of [
        "git_repo",
        "git_branch",
        "webhook_secret",
        "webhook_enabled",
        "github_webhook_id",
        "webhook_owner_user_id",
        "github_webhook_repo",
      ]) {
        db.run(`ALTER TABLE panel DROP COLUMN ${column}`);
      }

      db.run(`CREATE TRIGGER apps_bump_config_revision
        AFTER UPDATE OF
          domain, image_ref, container_port, auth_password_hash,
          environment_id, env_projection, public, health_check,
          health_check_mode, health_check_command, health_check_file,
          health_check_max_age_seconds, health_check_expected_statuses,
          internal_protocol, sticky, rate_limit_rps, ip_allowlist,
          health_check_path, compress, public_port, public_protocol,
          desired_replicas, min_replicas, max_replicas, autoscale_enabled,
          autoscale_cpu_threshold, autoscale_mem_threshold,
          autoscale_cooldown, autoscale_req_threshold, scale_to_zero_after,
          desired_volume_id, desired_volume_size, desired_volume_path,
          extra_volumes, memory_mb, cpu_limit, durability_class,
          max_per_host, min_locations, placement_pool
        ON apps
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE id = NEW.id;
        END`);
      db.run(`CREATE TRIGGER environments_bump_linked_app_config_revision
        AFTER UPDATE OF env_vars ON environments
        BEGIN
          UPDATE apps SET
            config_revision = config_revision + 1,
            rollout_requested_revision = CASE
              WHEN rollout_requested_revision > 0 THEN config_revision + 1
              ELSE 0
            END
          WHERE environment_id = NEW.id;
        END`);
    },
  },
  {
    version: 106,
    description: "Track dedicated GitHub Actions build runners",
    up: (db) => {
      db.run(`CREATE TABLE github_runners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE RESTRICT,
        name TEXT NOT NULL UNIQUE,
        scope_url TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT 'ocd-builder',
        runner_version TEXT NOT NULL DEFAULT '',
        architecture TEXT NOT NULL DEFAULT '',
        previous_pool TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'installing',
        last_error TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    version: 107,
    description: "Replace GitHub Actions runners with OCD build workers and repository webhook delivery",
    disableForeignKeys: true,
    up: (db) => {
      db.run("ALTER TABLE github_runners RENAME TO build_workers");
      for (const column of ["scope_url", "labels", "runner_version"]) {
        db.run(`ALTER TABLE build_workers DROP COLUMN ${column}`);
      }
      db.run("ALTER TABLE build_workers ADD COLUMN worker_version TEXT NOT NULL DEFAULT ''");
      db.run("UPDATE build_workers SET status = 'conversion_required', last_error = ''");
      db.run("UPDATE servers SET pool = 'build-workers' WHERE id IN (SELECT server_id FROM build_workers)");

      db.run(`CREATE TABLE build_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        worker_id INTEGER NOT NULL REFERENCES build_workers(id) ON DELETE RESTRICT,
        webhook_enabled INTEGER NOT NULL DEFAULT 1,
        last_delivery_id TEXT NOT NULL DEFAULT '',
        last_commit TEXT NOT NULL DEFAULT '',
        last_status TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        last_received_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repository, branch)
      )`);

      for (const statement of [
        "ALTER TABLE apps ADD COLUMN build_source_id INTEGER REFERENCES build_sources(id) ON DELETE SET NULL",
        "ALTER TABLE apps ADD COLUMN build_repository TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE apps ADD COLUMN build_branch TEXT NOT NULL DEFAULT 'main'",
        "ALTER TABLE apps ADD COLUMN build_dockerfile TEXT NOT NULL DEFAULT 'Dockerfile'",
        "ALTER TABLE apps ADD COLUMN build_context TEXT NOT NULL DEFAULT '.'",
        "ALTER TABLE apps ADD COLUMN build_image TEXT NOT NULL DEFAULT ''",
      ]) db.run(statement);

      // Existing immutable refs provide a safe default push repository. Source
      // checkout details are intentionally not guessed; the first v0.8
      // manifest apply supplies them before a webhook can be enabled.
      db.run(`UPDATE apps SET build_image = CASE
        WHEN instr(image_ref, '@sha256:') > 1 THEN substr(image_ref, 1, instr(image_ref, '@sha256:') - 1)
        ELSE '' END`);
    },
  },
  {
    version: 108,
    description: "Add durable build-worker capacity leases",
    up: (db) => {
      db.run("ALTER TABLE build_workers ADD COLUMN draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0, 1))");
      db.run("ALTER TABLE build_workers ADD COLUMN disk_free_bytes INTEGER NOT NULL DEFAULT 0 CHECK (disk_free_bytes >= 0)");
      db.run("ALTER TABLE build_workers ADD COLUMN last_used_at TEXT");
      db.run(`CREATE TABLE build_worker_leases (
        worker_id INTEGER NOT NULL REFERENCES build_workers(id) ON DELETE RESTRICT,
        slot INTEGER NOT NULL DEFAULT 0 CHECK (slot >= 0),
        operation_id INTEGER NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
        lease_token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        PRIMARY KEY (worker_id, slot)
      )`);
      db.run("CREATE INDEX build_worker_leases_expiry ON build_worker_leases(expires_at)");
    },
  },
  {
    version: 109,
    description: "Persist verified build artifacts and result checkpoints",
    up: (db) => {
      db.run(`CREATE TABLE build_artifacts (
        operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        target_name TEXT NOT NULL CHECK (length(target_name) > 0),
        image_ref TEXT NOT NULL CHECK (
          instr(image_ref, '@sha256:') > 1
          AND length(substr(image_ref, instr(image_ref, '@sha256:') + 8)) = 64
          AND substr(image_ref, instr(image_ref, '@sha256:') + 8) NOT GLOB '*[^0-9a-f]*'
        ),
        repository TEXT NOT NULL CHECK (length(repository) > 0),
        commit_sha TEXT NOT NULL CHECK (length(commit_sha) > 0),
        worker_id INTEGER REFERENCES build_workers(id) ON DELETE SET NULL,
        verified_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (operation_id, target_name)
      )`);
      db.run(`CREATE TRIGGER build_artifacts_image_ref_immutable
        BEFORE UPDATE OF image_ref ON build_artifacts
        WHEN OLD.image_ref <> NEW.image_ref
        BEGIN
          SELECT RAISE(ABORT, 'build artifact image_ref is immutable');
        END`);
      db.run("CREATE INDEX build_artifacts_source ON build_artifacts(repository, commit_sha)");
      db.run("CREATE INDEX build_artifacts_worker ON build_artifacts(worker_id)");

      db.run(`CREATE TABLE build_result_checkpoints (
        operation_id INTEGER PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
        repository TEXT NOT NULL CHECK (length(repository) > 0),
        commit_sha TEXT NOT NULL CHECK (length(commit_sha) > 0),
        worker_id INTEGER REFERENCES build_workers(id) ON DELETE SET NULL,
        output_json TEXT NOT NULL CHECK (json_valid(output_json)),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("CREATE INDEX build_result_checkpoints_source ON build_result_checkpoints(repository, commit_sha)");
      db.run("CREATE INDEX build_result_checkpoints_worker ON build_result_checkpoints(worker_id)");
    },
  },
  {
    version: 110,
    description: "Persist and compact build-source webhook deliveries",
    up: (db) => {
      db.run(`CREATE TABLE build_source_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES build_sources(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL CHECK (length(delivery_id) > 0),
        commit_sha TEXT NOT NULL CHECK (length(commit_sha) > 0),
        event_at TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
          'received', 'queued', 'building', 'deployed', 'failed',
          'duplicate', 'stale', 'superseded'
        )),
        superseded_by INTEGER REFERENCES build_source_deliveries(id) ON DELETE SET NULL,
        UNIQUE(source_id, delivery_id)
      )`);
      db.run(`CREATE INDEX build_source_deliveries_source_event
        ON build_source_deliveries(source_id, event_at DESC, received_at DESC, id DESC)`);
      db.run(`CREATE INDEX build_source_deliveries_source_status
        ON build_source_deliveries(source_id, status, event_at DESC, id DESC)`);
      db.run(`CREATE INDEX build_source_deliveries_operation
        ON build_source_deliveries(operation_id) WHERE operation_id IS NOT NULL`);
    },
  },
  {
    version: 111,
    description: "Add image runtime options to apps",
    up: (db) => {
      db.run("ALTER TABLE apps ADD COLUMN command_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(command_json))");
      db.run("ALTER TABLE apps ADD COLUMN cap_add_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cap_add_json))");
      db.run("ALTER TABLE apps ADD COLUMN post_start_command TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 112,
    description: "Remove managed services",
    disableForeignKeys: true,
    up: (db) => {
      const row = db.query("SELECT COUNT(*) AS count FROM services").get() as { count: number };
      if (row.count !== 0) {
        throw new Error(
          `Cannot remove managed-service tables while ${row.count} service(s) still exist. Migrate them to apps first.`,
        );
      }
      db.run("DELETE FROM user_permissions WHERE permission LIKE 'services.%'");
      db.run("DROP TABLE service_links");
      db.run("DROP TABLE service_instances");
      db.run("DROP TABLE services");
    },
  },
  {
    version: 113,
    description: "Repair committed manifest paths for webhook builds",
    up: (db) => {
      db.run(`UPDATE apps
        SET manifest_path = last_manifest_path
        WHERE manifest_path IS NULL
          AND last_manifest_path IS NOT NULL`);
    },
  },
  { version: 115, description: "Panel backups and email incidents", up: initializeProtectionSchema },
];

/** Helper for migration 82: merge two v2 entry lists (override wins by key) and
 *  serialize to the v2 env_vars blob. Ciphertext fields ride along untouched. */
function serializeMergedEntries(
  base: Array<{ key: string; [k: string]: any }>,
  over: Array<{ key: string; [k: string]: any }>,
): string {
  const byKey = new Map<string, { key: string; [k: string]: any }>();
  for (const e of base) byKey.set(e.key, e);
  for (const e of over) byKey.set(e.key, e);
  return JSON.stringify({ version: 2, entries: Array.from(byKey.values()) });
}

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
        `Database migration failed (${migration.description}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      if (migration.disableForeignKeys) {
        db.run("PRAGMA foreign_keys = ON");
      }
    }
  }

  log("run", `All migrations applied. Schema now at version ${pending[pending.length - 1].version}`);
}
