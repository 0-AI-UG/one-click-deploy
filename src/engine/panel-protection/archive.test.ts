import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encryptArchive, decryptArchive, generateRecoveryKey, sha256, type PanelArchive } from "./archive.ts";
import { restoreArchive } from "./restore.ts";
import { CURRENT_SCHEMA_VERSION, initializeCurrentSchema } from "../../shared/db/current-schema.ts";

function fixture(): PanelArchive {
  const db = new Database(":memory:");
  initializeCurrentSchema(db);
  db.run("INSERT INTO settings (key,value) VALUES ('recovery-test','saved')");
  const bytes = db.serialize(); db.close();
  return { version: 1, createdAt: new Date().toISOString(), image: "", schemaVersion: CURRENT_SCHEMA_VERSION, jwtSecret: "original-secret-".repeat(4), database: bytes.toString("base64"), databaseSha256: sha256(bytes), ssh: { id_ed25519: Buffer.from("private-key").toString("base64") } };
}
describe("encrypted panel backup recovery", () => {
  test("authenticates all backup bytes and the key", () => {
    const value = fixture(), key = generateRecoveryKey();
    const encrypted = encryptArchive(value, key);
    expect(encrypted.includes(Buffer.from(value.jwtSecret))).toBe(false);
    expect(decryptArchive(encrypted, key)).toEqual(value);
    expect(() => decryptArchive(encrypted, generateRecoveryKey())).toThrow("authentication");
    encrypted[40] ^= 1;
    expect(() => decryptArchive(encrypted, key)).toThrow("authentication");
  });
  test("rejects unsafe archive paths and invalid database checksums", () => {
    const key = generateRecoveryKey(), value = fixture();
    value.ssh = { "../escape": "eA==" };
    expect(() => decryptArchive(encryptArchive(value, key), key)).toThrow("SSH");
    value.ssh = {}; value.databaseSha256 = "wrong";
    expect(() => decryptArchive(encryptArchive(value, key), key)).toThrow("checksum");
  });
  test("restores SQLite, key and SSH files to a new directory with automation paused", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ocd-restore-test-"));
    try {
      const target = path.join(dir, "restored"), key = generateRecoveryKey(), value = fixture();
      const encrypted = encryptArchive(value, key);
      restoreArchive(encrypted, key, target);
      const restored = new Database(path.join(target, "deploy.db"), { readonly: true });
      expect(restored.query("SELECT value FROM settings WHERE key='recovery-test'").get()).toEqual({ value: "saved" });
      expect(restored.query("SELECT value FROM settings WHERE key='panel_backup_enabled'").get()).toEqual({ value: "0" });
      restored.close();
      expect(readFileSync(path.join(target, "jwt-secret"), "utf8")).toBe(value.jwtSecret);
      expect(readFileSync(path.join(target, "ssh/id_ed25519"), "utf8")).toBe("private-key");
      expect(statSync(path.join(target, "jwt-secret")).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(target, "recovery-pending.json"))).toBe(true);
      expect(() => restoreArchive(encrypted, key, target)).toThrow("already exists");
      expect(() => restoreArchive(encrypted, generateRecoveryKey(), path.join(dir, "wrong-key"))).toThrow();
      expect(existsSync(path.join(dir, "wrong-key"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
