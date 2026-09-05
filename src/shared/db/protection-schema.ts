import type { Database } from "bun:sqlite";

export function initializeProtectionSchema(db: Database): void {
  db.run(`CREATE TABLE panel_backups (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
    bucket TEXT NOT NULL, object_key TEXT NOT NULL, endpoint TEXT NOT NULL,
    connection_id TEXT NOT NULL, region TEXT NOT NULL,
    checksum TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', finished_at INTEGER
  )`);
  db.run(`CREATE TABLE panel_alerts (
    key TEXT PRIMARY KEY, incident_id TEXT NOT NULL, title TEXT NOT NULL,
    path TEXT NOT NULL, first_seen INTEGER NOT NULL, opened_at INTEGER,
    resolved_at INTEGER
  )`);
  db.run(`CREATE TABLE panel_email_outbox (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
    sent_at INTEGER, error TEXT NOT NULL DEFAULT ''
  )`);
}
