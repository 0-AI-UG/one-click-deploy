import { test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import db, { saveSetting } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { generateRecoveryKey, decryptArchive } from "./archive.ts";
import { restoreArchive } from "./restore.ts";

const objects = new Map<string, Buffer>();
let corrupt = false;
let deleteFails = false;
const removed: string[] = [];
mock.module("../object-storage/s3.ts", () => ({
  getS3Credentials: async () => ({ endpoint: "https://storage.example.com", region: "test", accessKey: "access", secretKey: "secret" }),
  putObject: async (bucket: string, key: string, body: Uint8Array) => { objects.set(`${bucket}/${key}`, Buffer.from(body)); },
  getObject: async (bucket: string, key: string) => corrupt ? Buffer.from("corrupt") : objects.get(`${bucket}/${key}`)!,
  deleteObject: async (bucket: string, key: string) => { if (deleteFails) throw new Error("denied"); removed.push(`${bucket}/${key}`); objects.delete(`${bucket}/${key}`); },
}));
const { requestBackup, backupTick, listBackups, pruneBackups } = await import("./backups.ts");
let recoveryKey: string;
beforeEach(async () => {
  objects.clear(); removed.length = 0; corrupt = false; deleteFails = false;
  recoveryKey = generateRecoveryKey();
  await secretStore.set("panel_backup_recovery_key", recoveryKey);
  await secretStore.set("test-provider-secret", "credential-to-recover");
  saveSetting("panel_backup_connection", "test-storage");
  saveSetting("panel_backup_bucket", "backup-bucket");
  saveSetting("panel_backup_retention", "1");
});
test("snapshots live SQLite, verifies S3 bytes and restores encrypted credentials", async () => {
  const id = await requestBackup(); expect(await requestBackup()).toBe(id);
  await backupTick();
  const backup = listBackups()[0]; expect(backup.status).toBe("complete");
  const encrypted = objects.get(`${backup.bucket}/${backup.object_key}`)!;
  const archive = decryptArchive(encrypted, recoveryKey);
  expect(archive.database.length).toBeGreaterThan(0);
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-backup-e2e-"));
  try {
    restoreArchive(encrypted, recoveryKey, path.join(dir, "restored"));
    const restored = new Database(path.join(dir, "restored/deploy.db"), { readonly: true });
    expect(restored.query("SELECT encrypted_value FROM encrypted_secrets WHERE key='test-provider-secret'").get()).toEqual(db.query("SELECT encrypted_value FROM encrypted_secrets WHERE key='test-provider-secret'").get());
    restored.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("unverified upload never expires a known good backup", async () => {
  await requestBackup(); await backupTick();
  corrupt = true;
  await requestBackup(); await backupTick();
  expect(listBackups().some(b => b.status === "failed")).toBe(true);
  expect(listBackups().filter(b => b.status === "complete").length).toBe(1);
  expect(removed).toEqual([]);
});
test("retention removes only known objects after success, and preserves failures for retry", async () => {
  await requestBackup(); await backupTick();
  const first = listBackups()[0];
  db.query("UPDATE panel_backups SET created_at=1 WHERE id=?").run(first.id);
  deleteFails = true;
  await requestBackup(); await backupTick();
  expect(listBackups().filter(b => b.status === "complete").length).toBe(2);
  deleteFails = false; await pruneBackups();
  expect(removed).toEqual([`${first.bucket}/${first.object_key}`]);
  expect(listBackups().filter(b => b.status === "expired").length).toBe(1);
});
test("disabled scheduling still processes manual requests, enabled scheduling is daily", async () => {
  await backupTick(); expect(listBackups()).toEqual([]);
  saveSetting("panel_backup_enabled", "1");
  await backupTick(); await backupTick();
  expect(listBackups().length).toBe(1);
});
