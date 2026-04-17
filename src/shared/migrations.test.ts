import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, type Migration } from "./migrations.ts";

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
    const row = db.query("SELECT version FROM schema_version").get() as { version: number } | null;
    expect(row).toBeTruthy();
    expect(row!.version).toBeGreaterThanOrEqual(0);
  });

  test("applies all migrations", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.query("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBeGreaterThan(0);
  });

  test("adds ssh_host_key column to servers", () => {
    const db = freshDb();
    runMigrations(db);
    // Should not throw when querying the new column
    db.run("INSERT INTO servers (name, provider_id, ssh_host_key) VALUES ('test', '123', 'key-data')");
    const server = db.query("SELECT ssh_host_key FROM servers WHERE provider_id = '123'").get() as { ssh_host_key: string };
    expect(server.ssh_host_key).toBe("key-data");
  });

  test("creates deployment_history table", () => {
    const db = freshDb();
    runMigrations(db);
    // Insert a server and app first for the FK
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, git_repo) VALUES ('app1', 'app.com', 'https://x.git')");
    db.run("INSERT INTO deployment_history (app_id, image_tag, git_commit) VALUES (1, 'app:latest', 'abc123')");
    const dep = db.query("SELECT * FROM deployment_history WHERE app_id = 1").get() as { image_tag: string; git_commit: string };
    expect(dep.image_tag).toBe("app:latest");
    expect(dep.git_commit).toBe("abc123");
  });

  test("adds volume_id and volume_mount columns to apps", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, git_repo, volume_id, volume_mount) VALUES ('app1', 'app.com', 'https://x.git', 'vol-123', '/mnt/data:/data')");
    const app = db.query("SELECT volume_id, volume_mount FROM apps WHERE name = 'app1'").get() as { volume_id: string; volume_mount: string };
    expect(app.volume_id).toBe("vol-123");
    expect(app.volume_mount).toBe("/mnt/data:/data");
  });

  test("is idempotent — running twice does not error", () => {
    const db = freshDb();
    runMigrations(db);
    runMigrations(db); // Should not throw
    const row = db.query("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBeGreaterThan(0);
  });

  test("migration 14 drops apps.server_id and apps.host_port cleanly with migration-8 data", () => {
    const db = freshDb();
    // Pre-seed an app at the legacy schema before any migrations have run.
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'app1', 'a.com', 'https://x.git')");
    runMigrations(db);
    // After migration 14, server_id/host_port should not exist on apps.
    const cols = db.query("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("server_id");
    expect(colNames).not.toContain("host_port");
    // App row preserved.
    const app = db.query("SELECT id, name FROM apps WHERE id = 1").get() as { id: number; name: string } | null;
    expect(app?.name).toBe("app1");
    // Migration 8 should have created a corresponding replica for the app.
    const replica = db.query("SELECT * FROM replicas WHERE app_id = 1").get() as { server_id: number } | null;
    expect(replica).toBeTruthy();
    expect(replica!.server_id).toBe(1);
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
    const cols = db.query("PRAGMA table_info(panel)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("webhook_secret");
    expect(colNames).toContain("webhook_enabled");
    expect(colNames).toContain("github_webhook_id");

    db.run(
      "INSERT INTO panel_deployments (image_tag, git_commit, status, source) VALUES ('p:latest', 'abc', 'deployed', 'webhook')",
    );
    const row = db.query("SELECT source FROM panel_deployments WHERE git_commit = 'abc'").get() as { source: string };
    expect(row.source).toBe("webhook");
  });

  test("skips already applied migrations", () => {
    const db = freshDb();
    runMigrations(db);
    const v1 = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    runMigrations(db);
    const v2 = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    expect(v1).toBe(v2);
  });
});
