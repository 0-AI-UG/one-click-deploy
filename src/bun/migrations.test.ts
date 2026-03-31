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
    db.run("INSERT INTO servers (name, hetzner_id, ssh_host_key) VALUES ('test', '123', 'key-data')");
    const server = db.query("SELECT ssh_host_key FROM servers WHERE hetzner_id = '123'").get() as any;
    expect(server.ssh_host_key).toBe("key-data");
  });

  test("creates deployment_history table", () => {
    const db = freshDb();
    runMigrations(db);
    // Insert a server and app first for the FK
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'app1', 'app.com', 'https://x.git')");
    db.run("INSERT INTO deployment_history (app_id, image_tag, git_commit) VALUES (1, 'app:latest', 'abc123')");
    const dep = db.query("SELECT * FROM deployment_history WHERE app_id = 1").get() as any;
    expect(dep.image_tag).toBe("app:latest");
    expect(dep.git_commit).toBe("abc123");
  });

  test("adds volume_id and volume_mount columns to apps", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo, volume_id, volume_mount) VALUES (1, 'app1', 'app.com', 'https://x.git', 'vol-123', '/mnt/data:/data')");
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

  test("skips already applied migrations", () => {
    const db = freshDb();
    runMigrations(db);
    const v1 = (db.query("SELECT version FROM schema_version").get() as any).version;
    runMigrations(db);
    const v2 = (db.query("SELECT version FROM schema_version").get() as any).version;
    expect(v1).toBe(v2);
  });
});
