import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const MAGIC = Buffer.from("OCD-BACKUP-1\n");
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export type PanelArchive = {
  version: 1;
  createdAt: string;
  image: string;
  schemaVersion: number;
  jwtSecret: string;
  database: string;
  databaseSha256: string;
  ssh: Record<string, string>;
};
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const generateRecoveryKey = () => randomBytes(32).toString("hex");
function keyBytes(key: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Recovery key must contain 64 lowercase hexadecimal characters");
  return Buffer.from(key, "hex");
}
export function encryptArchive(archive: PanelArchive, key: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(MAGIC);
  const compressed = gzipSync(JSON.stringify(archive));
  return Buffer.concat([MAGIC, iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}
export function decryptArchive(bytes: Buffer, key: string): PanelArchive {
  if (bytes.length > MAX_ARCHIVE_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.length < MAGIC.length + 28) {
    throw new Error("Unsupported panel backup");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), bytes.subarray(MAGIC.length, MAGIC.length + 12));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(bytes.subarray(-16));
  let archive: PanelArchive;
  try {
    const compressed = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 12, -16)), decipher.final()]);
    archive = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES }).toString());
  } catch { throw new Error("Backup authentication failed: incorrect recovery key or damaged archive"); }
  if (archive.version !== 1 || typeof archive.jwtSecret !== "string" || !archive.jwtSecret ||
      typeof archive.database !== "string" || !Number.isInteger(archive.schemaVersion) ||
      !archive.ssh || typeof archive.ssh !== "object" || Array.isArray(archive.ssh)) throw new Error("Invalid backup metadata");
  if (sha256(Buffer.from(archive.database, "base64")) !== archive.databaseSha256) throw new Error("Database checksum mismatch");
  for (const [name, value] of Object.entries(archive.ssh)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === ".." || typeof value !== "string") throw new Error("Invalid SSH backup entry");
  }
  return archive;
}
