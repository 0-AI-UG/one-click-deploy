import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("OCDPGB01");
const HEADER_SIZE = 36; // magic + 16-byte salt + 12-byte nonce

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 32) throw new Error("Backup encryption key must have at least 32 characters");
  return scryptSync(passphrase, salt, 32);
}

export async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function encryptArchive(source: string, destination: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);
  const file = await open(destination, "wx", 0o600);
  try { await file.write(header); } finally { await file.close(); }
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: "a" }));
  await appendFile(destination, cipher.getAuthTag());
}

/** Only use the plaintext after this promise resolves and authenticates it. */
export async function decryptArchive(source: string, destination: string, passphrase: string): Promise<void> {
  const size = (await stat(source)).size;
  if (size <= HEADER_SIZE + 16) throw new Error("Truncated backup");
  const file = await open(source, "r");
  const header = Buffer.alloc(HEADER_SIZE);
  const tag = Buffer.alloc(16);
  try {
    await file.read(header, 0, HEADER_SIZE, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally { await file.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("Unsupported backup format");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, header.subarray(8, 24)), header.subarray(24));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  // Reserve the destination first: a failed authentication must never remove
  // or overwrite a file that belonged to the caller before this invocation.
  const destinationFile = await open(destination, "wx", 0o600);
  await destinationFile.close();
  try {
    await pipeline(createReadStream(source, { start: HEADER_SIZE, end: size - 17 }), decipher,
      createWriteStream(destination, { flags: "w", mode: 0o600 }));
  } catch (error) { await rm(destination, { force: true }); throw error; }
}
