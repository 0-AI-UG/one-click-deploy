import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptArchive, encryptArchive } from "./archive.ts";
import { postgresEnvironment, publishBackup } from "./backup.ts";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "ocd-backup-test-"));
  directories.push(value);
  return value;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

test("archives decrypt exactly and reject modified ciphertext and wrong keys", async () => {
  const dir = await directory();
  const source = join(dir, "source");
  const encrypted = join(dir, "encrypted");
  const payload = crypto.getRandomValues(new Uint8Array(65000));
  await writeFile(source, payload);
  await encryptArchive(source, encrypted, "a".repeat(32));
  await decryptArchive(encrypted, join(dir, "plain"), "a".repeat(32));
  expect(await readFile(join(dir, "plain"))).toEqual(Buffer.from(payload));
  await expect(decryptArchive(encrypted, join(dir, "wrong-key"), "b".repeat(32))).rejects.toThrow();
  const bytes = await readFile(encrypted);
  bytes[50] = bytes[50]! ^ 1;
  await writeFile(encrypted, bytes);
  await expect(decryptArchive(encrypted, join(dir, "tampered"), "a".repeat(32))).rejects.toThrow();
});

test("corrupted uploads never produce a completion record", async () => {
  const dir = await directory();
  const file = join(dir, "backup");
  await writeFile(file, "original");
  const uploads: string[] = [];
  await expect(publishBackup({
    async upload(key) { uploads.push(key); },
    async download(_key, path) { await writeFile(path, "corrupted"); },
  }, file, 4, "shared-postgres", dir)).rejects.toThrow("checksum mismatch");
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toEndWith("/cluster.ocdpg");
});

test("database credentials stay in the child environment and preserve TLS mode", () => {
  const env = postgresEnvironment("postgresql://backup:p%40ss@db.internal:5432/app?sslmode=require");
  expect(env.PGPASSWORD).toBe("p@ss");
  expect(env.PGDATABASE).toBe("postgres");
  expect(env.PGSSLMODE).toBe("require");
  expect(env.PGOPTIONS).toContain("default_transaction_read_only=on");
});
