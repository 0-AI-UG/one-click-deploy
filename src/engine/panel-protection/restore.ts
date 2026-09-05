import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { decryptArchive } from "./archive.ts";
import { CURRENT_SCHEMA_VERSION } from "../../shared/db/current-schema.ts";

/** Offline only. Never replace an existing data directory, even if it looks empty. */
export function restoreArchive(bytes: Buffer, recoveryKey: string, target: string): { image: string; createdAt: string } {
  target = path.resolve(target);
  if (existsSync(target)) throw new Error("Restore destination already exists; choose a new data directory");
  const archive = decryptArchive(bytes, recoveryKey);
  if (archive.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new Error(`Backup schema ${archive.schemaVersion} requires a matching OCD release (this release uses ${CURRENT_SCHEMA_VERSION})`);
  mkdirSync(path.dirname(target), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(target), ".ocd-restore-"));
  try {
    writeFileSync(path.join(staging, "deploy.db"), Buffer.from(archive.database, "base64"), { mode: 0o600 });
    const restored = new Database(path.join(staging, "deploy.db"));
    try {
      const integrity = restored.query("PRAGMA integrity_check").get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok" || restored.query("PRAGMA foreign_key_check").all().length) throw new Error("Restored database integrity check failed");
      const version = restored.query("SELECT version FROM schema_version").get() as { version: number };
      if (version.version !== archive.schemaVersion) throw new Error("Backup schema metadata does not match database");
      // Outbox entries and an in-flight backup in the snapshot refer to the old timeline.
      restored.run("DELETE FROM panel_email_outbox WHERE sent_at IS NULL");
      restored.run("UPDATE panel_backups SET status='failed', error='Interrupted by panel restore' WHERE status IN ('pending','running')");
      restored.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('panel_backup_enabled','0')");
      restored.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { restored.close(); }
    mkdirSync(path.join(staging, "ssh"), { mode: 0o700 });
    for (const [name, data] of Object.entries(archive.ssh)) writeFileSync(path.join(staging, "ssh", name), Buffer.from(data, "base64"), { mode: 0o600 });
    writeFileSync(path.join(staging, "jwt-secret"), archive.jwtSecret, { mode: 0o600 });
    writeFileSync(path.join(staging, "recovery-pending.json"), JSON.stringify({ restoredAt: new Date().toISOString(), backupCreatedAt: archive.createdAt, image: archive.image }), { mode: 0o600 });
    if (existsSync(target)) throw new Error("Restore destination was created by another process");
    renameSync(staging, target);
    return { image: archive.image, createdAt: archive.createdAt };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
