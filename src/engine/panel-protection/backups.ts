import { mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import db, { getPanel, getSettings, saveSetting } from "../../shared/db.ts";
import { SSH_DIR } from "../../shared/paths.ts";
import { getJwtSecret, secretStore } from "../../shared/secret-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../shared/db/current-schema.ts";
import { getS3Credentials, putObject, getObject, deleteObject } from "../object-storage/s3.ts";
import { encryptArchive, sha256, MAX_ARCHIVE_BYTES } from "./archive.ts";

export type BackupRow = { id: string; created_at: number; status: string; connection_id: string; region: string; bucket: string; object_key: string; endpoint: string; checksum: string; size_bytes: number; error: string; finished_at: number | null };
export const listBackups = () => db.query("SELECT * FROM panel_backups ORDER BY created_at DESC, rowid DESC LIMIT 100").all() as BackupRow[];
export async function requestBackup(): Promise<string> {
  const settings = getSettings();
  const credentials = settings.panel_backup_connection ? await getS3Credentials(settings.panel_backup_connection) : null;
  if (!credentials || !settings.panel_backup_bucket || !await secretStore.get("panel_backup_recovery_key")) throw new Error("Configure object storage, backup bucket, and recovery key first");
  const id = crypto.randomUUID();
  const key = `${settings.panel_backup_prefix || "ocd-panel"}/${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.ocdb`;
  return db.transaction(() => {
    const active = db.query("SELECT id FROM panel_backups WHERE status IN ('pending','running')").get() as { id: string } | null;
    if (active) return active.id;
    db.query("INSERT INTO panel_backups (id, created_at, status, bucket, object_key, endpoint, connection_id, region) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)").run(id, Date.now(), settings.panel_backup_bucket, key, credentials.endpoint, settings.panel_backup_connection, credentials.region);
    return id;
  })();
}

export async function performBackup(row: BackupRow): Promise<void> {
  const credentials = await getS3Credentials(row.connection_id);
  const key = await secretStore.get("panel_backup_recovery_key");
  if (!credentials || credentials.endpoint !== row.endpoint || credentials.region !== row.region || !key) throw new Error("Backup storage connection changed or recovery key is unavailable");
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-panel-backup-"));
  try {
    const snapshotPath = path.join(dir, "deploy.db");
    db.run(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    const snapshot = new Database(snapshotPath, { readonly: true });
    try {
      const check = snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string };
      if (check.integrity_check !== "ok") throw new Error("Panel database integrity check failed");
    } finally { snapshot.close(); }
    const database = readFileSync(snapshotPath);
    if (database.length > MAX_ARCHIVE_BYTES / 2) throw new Error("Panel database exceeds the supported backup size (256 MiB)");
    const ssh: Record<string, string> = {};
    let names: string[] = [];
    try { names = readdirSync(SSH_DIR); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of names) {
      const file = path.join(SSH_DIR, name);
      if (!lstatSync(file).isFile()) throw new Error("SSH directory must contain regular files only");
      ssh[name] = readFileSync(file).toString("base64");
    }
    const encrypted = encryptArchive({ version: 1, createdAt: new Date().toISOString(), image: getPanel()?.image_ref || "", schemaVersion: CURRENT_SCHEMA_VERSION, jwtSecret: getJwtSecret(), database: database.toString("base64"), databaseSha256: sha256(database), ssh }, key);
    if (encrypted.length > MAX_ARCHIVE_BYTES) throw new Error("Backup exceeds maximum archive size");
    await putObject(row.bucket, row.object_key, encrypted, credentials);
    // Verify the uploaded bytes before declaring success or deleting an old backup.
    const downloaded = await getObject(row.bucket, row.object_key, credentials);
    if (sha256(downloaded) !== sha256(encrypted)) throw new Error("Uploaded backup checksum verification failed");
    db.query("UPDATE panel_backups SET status='complete', checksum=?, size_bytes=?, finished_at=? WHERE id=?").run(sha256(encrypted), encrypted.length, Date.now(), row.id);
    saveSetting("panel_backup_last_success", String(Date.now()));
    await pruneBackups();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function pruneBackups(): Promise<void> {
  const settings = getSettings();
  const credentials = settings.panel_backup_connection ? await getS3Credentials(settings.panel_backup_connection) : null;
  if (!credentials) return;
  const keep = Number(getSettings().panel_backup_retention || 7);
  const rows = db.query("SELECT * FROM panel_backups WHERE status='complete' AND connection_id=? AND endpoint=? AND region=? AND bucket=? ORDER BY created_at DESC, rowid DESC").all(settings.panel_backup_connection, credentials.endpoint, credentials.region, settings.panel_backup_bucket) as BackupRow[];
  // Delete only exact objects OCD recorded; never list/delete arbitrary bucket contents.
  for (const old of rows.slice(keep)) {
    try {
      await deleteObject(old.bucket, old.object_key, credentials);
      db.query("UPDATE panel_backups SET status='expired', error='' WHERE id=?").run(old.id);
    } catch {
      db.query("UPDATE panel_backups SET error='Retention deletion failed; backup retained' WHERE id=?").run(old.id);
    }
  }
}

export async function backupTick(now = Date.now()): Promise<void> {
  // Interrupted uploads are safe to retry as new snapshots; incomplete objects are never restore candidates.
  db.query("UPDATE panel_backups SET status='failed', error='Backup interrupted or timed out', finished_at=? WHERE status='running' AND created_at < ?").run(now, now - 30 * 60_000);
  const settings = getSettings();
  const latest = db.query("SELECT created_at, status FROM panel_backups ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { created_at: number; status: string } | null;
  if (settings.panel_backup_enabled === "1" && (!latest || now - latest.created_at >= (latest.status === "failed" ? 3600_000 : 86400_000))) await requestBackup();
  const row = db.query("SELECT * FROM panel_backups WHERE status='pending' ORDER BY created_at LIMIT 1").get() as BackupRow | null;
  if (!row) return;
  const claim = db.query("UPDATE panel_backups SET status='running' WHERE id=? AND status='pending'").run(row.id);
  if (!claim.changes) return;
  try { await performBackup(row); }
  catch {
    // Provider responses can contain secrets: expose a bounded, generic diagnostic.
    db.query("UPDATE panel_backups SET status='failed', error='Backup failed. Check object storage access, free disk space, and panel database integrity.', finished_at=? WHERE id=?").run(Date.now(), row.id);
  }
}
