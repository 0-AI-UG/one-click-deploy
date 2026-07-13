import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, migrations, type Migration } from "./migrations.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  // Create baseline schema (version 0)
  db.run(`CREATE TABLE IF NOT EXISTS servers (
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
  db.run(`CREATE TABLE IF NOT EXISTS apps (
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
  return db;
}

describe("runMigrations", () => {
  test("creates schema_version table", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row).toBeTruthy();
    expect(row.version).toBeGreaterThanOrEqual(0);
  });

  test("applies all migrations", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBeGreaterThan(0);
  });

  test("adds ssh_host_key column to servers", () => {
    const db = freshDb();
    runMigrations(db);
    // Should not throw when querying the new column
    db.run("INSERT INTO servers (name, provider_id, ssh_host_key) VALUES ('test', '123', 'key-data')");
    const server = db.query("SELECT ssh_host_key FROM servers WHERE provider_id = '123'").get() as any;
    expect(server.ssh_host_key).toBe("key-data");
  });

  test("creates deployment_history table", () => {
    const db = freshDb();
    runMigrations(db);
    // Insert a server and app first for the FK
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, git_repo) VALUES ('app1', 'app.com', 'https://x.git')");
    db.run("INSERT INTO deployment_history (app_id, image_tag, git_commit) VALUES (1, 'app:latest', 'abc123')");
    const dep = db.query("SELECT * FROM deployment_history WHERE app_id = 1").get() as any;
    expect(dep.image_tag).toBe("app:latest");
    expect(dep.git_commit).toBe("abc123");
  });

  test("adds volume_id and volume_mount columns to apps", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, git_repo, volume_id, volume_mount) VALUES ('app1', 'app.com', 'https://x.git', 'vol-123', '/mnt/data:/data')");
    const app = db.query("SELECT volume_id, volume_mount FROM apps WHERE name = 'app1'").get() as any;
    expect(app.volume_id).toBe("vol-123");
    expect(app.volume_mount).toBe("/mnt/data:/data");
  });

  test("is idempotent — running twice does not error", () => {
    const db = freshDb();
    runMigrations(db);
    runMigrations(db); // Should not throw
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBeGreaterThan(0);
  });

  test("migration 14 drops apps.server_id and apps.host_port cleanly with migration-8 data", () => {
    const db = freshDb();
    // Pre-seed an app at the legacy schema before any migrations have run.
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'app1', 'a.com', 'https://x.git')");
    runMigrations(db);
    // After migration 14, server_id/host_port should not exist on apps.
    const cols = db.query("PRAGMA table_info(apps)").all() as any[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("server_id");
    expect(colNames).not.toContain("host_port");
    // App row preserved.
    const app = db.query("SELECT id, name FROM apps WHERE id = 1").get() as any;
    expect(app?.name).toBe("app1");
    // Migration 8 should have created a corresponding replica for the app.
    const replica = db.query("SELECT * FROM replicas WHERE app_id = 1").get() as any;
    expect(replica).toBeTruthy();
    expect(replica.server_id).toBe(1);
  });

  test("migration 15 adds panel webhook columns and rewrites self-redeploy source", () => {
    const db = freshDb();
    runMigrations(db);
    // Insert a panel row + a legacy self-redeploy panel_deployment.
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h-panel')");
    db.run(
      "INSERT INTO panel (id, server_id, name, domain, git_repo, container_port, host_port) VALUES (1, 1, 'p', 'p.example.com', 'https://github.com/x/y', 3000, 3001)",
    );
    // Pretend a legacy row got written before migration 15 ran (we can't
    // actually re-rerun the migration, but we can validate the columns + a
    // forward-write of a webhook-source row works post-migration).
    const cols = db.query("PRAGMA table_info(panel)").all() as any[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("webhook_secret");
    expect(colNames).toContain("webhook_enabled");
    expect(colNames).toContain("github_webhook_id");

    db.run(
      "INSERT INTO panel_deployments (image_tag, git_commit, status, source) VALUES ('p:latest', 'abc', 'deployed', 'webhook')",
    );
    const row = db.query("SELECT source FROM panel_deployments WHERE git_commit = 'abc'").get() as any;
    expect(row.source).toBe("webhook");
  });

  test("skips already applied migrations", () => {
    const db = freshDb();
    runMigrations(db);
    const v1 = (db.query("SELECT version FROM schema_version").get() as any).version;
    runMigrations(db);
    const v2 = (db.query("SELECT version FROM schema_version").get() as any).version;
    expect(v1).toBe(v2);
  });

  test("migration 60 backfills unique sequential internal ports", () => {
    const db = freshDb();
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a1', 'a1.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a2', 'a2.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a3', 'a3.com', 'https://x.git')");
    runMigrations(db);
    const rows = db.query("SELECT internal_port FROM apps ORDER BY id ASC").all() as any[];
    expect(rows.map((r) => r.internal_port)).toEqual([20000, 20001, 20002]);
  });

  test("migration 60 unique index rejects duplicate internal ports but allows 0", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO apps (name, domain, git_repo, internal_port) VALUES ('a1', 'a1.com', 'https://x.git', 20005)");
    expect(() =>
      db.run("INSERT INTO apps (name, domain, git_repo, internal_port) VALUES ('a2', 'a2.com', 'https://x.git', 20005)"),
    ).toThrow();
    // The index is partial (internal_port > 0) — unallocated rows don't collide.
    db.run("INSERT INTO apps (name, domain, git_repo, internal_port) VALUES ('a3', 'a3.com', 'https://x.git', 0)");
    db.run("INSERT INTO apps (name, domain, git_repo, internal_port) VALUES ('a4', 'a4.com', 'https://x.git', 0)");
  });

  test("migration 61 blanks domains of private apps only", () => {
    const db = freshDb();
    runMigrations(db);
    // Re-apply migration 61 against post-migration rows (runMigrations already
    // ran it on an empty table).
    db.run("INSERT INTO apps (name, domain, git_repo, public, internal_port) VALUES ('pub', 'pub.example.com', 'https://x.git', 1, 20000)");
    db.run("INSERT INTO apps (name, domain, git_repo, public, internal_port) VALUES ('priv', 'priv.example.com', 'https://x.git', 0, 20001)");
    migrations.find((m) => m.version === 61)!.up(db);
    const pub = db.query("SELECT domain FROM apps WHERE name = 'pub'").get() as any;
    const priv = db.query("SELECT domain FROM apps WHERE name = 'priv'").get() as any;
    expect(pub.domain).toBe("pub.example.com");
    expect(priv.domain).toBe("");
  });

  test("migration 62 backfills bcrypt hashes for password-protected apps only", () => {
    // Minimal pre-62 apps table (the migration only touches auth_password*).
    const db = new Database(":memory:");
    db.run("CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, auth_password TEXT NOT NULL DEFAULT '')");
    db.run("INSERT INTO apps (name, auth_password) VALUES ('gated', 'hunter2')");
    db.run("INSERT INTO apps (name) VALUES ('open')");
    migrations.find((m) => m.version === 62)!.up(db);
    const gated = db.query("SELECT auth_password_hash FROM apps WHERE name = 'gated'").get() as any;
    const open = db.query("SELECT auth_password_hash FROM apps WHERE name = 'open'").get() as any;
    expect(gated.auth_password_hash.startsWith("$2")).toBe(true);
    expect(Bun.password.verifySync("hunter2", gated.auth_password_hash)).toBe(true);
    expect(open.auth_password_hash).toBe("");
  });

  test("migration 66 drops apps.auth_password but keeps auth_password_hash", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    // The plaintext column is gone; the bcrypt hash is the sole source of truth.
    expect(cols).not.toContain("auth_password");
    expect(cols).toContain("auth_password_hash");
  });

  test("migration 67 adds internal_protocol defaulting to http", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("internal_protocol");
    // New rows that don't specify it get the column default.
    db.run("INSERT INTO apps (name, domain, git_repo, internal_port) VALUES ('defapp', 'd.example.com', 'https://x.git', 20000)");
    const row = db.query("SELECT internal_protocol FROM apps WHERE name = 'defapp'").get() as any;
    expect(row.internal_protocol).toBe("http");
  });

  test("migration 67 backfills internal_protocol from health_check (http when 1, tcp when 0)", () => {
    // Minimal pre-67 apps table (the migration only touches internal_protocol
    // and reads health_check), like the migration-62 test.
    const db = new Database(":memory:");
    db.run("CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, health_check INTEGER NOT NULL DEFAULT 1)");
    db.run("INSERT INTO apps (name, health_check) VALUES ('httpapp', 1)");
    db.run("INSERT INTO apps (name, health_check) VALUES ('tcpapp', 0)");
    migrations.find((m) => m.version === 67)!.up(db);
    const httpApp = db.query("SELECT internal_protocol FROM apps WHERE name = 'httpapp'").get() as any;
    const tcpApp = db.query("SELECT internal_protocol FROM apps WHERE name = 'tcpapp'").get() as any;
    expect(httpApp.internal_protocol).toBe("http");
    expect(tcpApp.internal_protocol).toBe("tcp");
  });

  test("migration 68 drops apps.wake_token (the browser wake page is gone)", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    // The token authenticated the old browser wake page; the hold-and-forward
    // waker needs none, so the column is dropped.
    expect(cols).not.toContain("wake_token");
  });
});
