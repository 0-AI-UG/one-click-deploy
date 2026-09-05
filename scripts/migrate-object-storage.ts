/** One-time copy from legacy S3 credentials to an OCD-scoped destination.
 * Dry run by default. Never deletes source objects or overwrites unequal data.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OcdStorageClient } from "../packages/storage-client/index.ts";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
async function digest(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

const source = process.env.SOURCE_OCD_STORAGE_TOKEN
  ? new OcdStorageClient(required("OCD_STORAGE_URL"), required("SOURCE_OCD_STORAGE_TOKEN"))
  : new Bun.S3Client({ bucket: required("SOURCE_S3_BUCKET"), endpoint: required("SOURCE_S3_ENDPOINT"),
  region: required("SOURCE_S3_REGION"), accessKeyId: required("SOURCE_S3_ACCESS_KEY_ID"), secretAccessKey: required("SOURCE_S3_SECRET_ACCESS_KEY") });
const destination = new OcdStorageClient(required("OCD_STORAGE_URL"), required("OCD_STORAGE_TOKEN"));
const prefix = process.env.SOURCE_PREFIX ?? "";
if (prefix && !prefix.endsWith("/")) throw new Error("SOURCE_PREFIX must end in /");
const execute = process.argv.includes("--execute");
// Only use after a full verified copy of an immutable source. Foody stores
// content hashes on immutable objects, making the paused final pass inexpensive.
const verifiedImmutablePass = process.argv.includes("--verified-immutable-pass");
let continuationToken: string | undefined;
let objects = 0;
let copied = 0;
do {
  const page = await source.list({ prefix, maxKeys: 1000, continuationToken });
  for (const item of page.contents ?? []) {
    if (!item.key?.startsWith(prefix)) throw new Error("Provider returned an out-of-prefix object");
    const targetKey = item.key.slice(prefix.length);
    if (!targetKey || targetKey.endsWith("/")) continue;
    objects++;
    if (!execute) continue;
    const directory = await mkdtemp(join(tmpdir(), "ocd-storage-copy-"));
    try {
      const file = source.file(item.key);
      const metadata = await file.stat();
      if (verifiedImmutablePass && "sha256" in metadata && typeof metadata.sha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.sha256)) {
        try {
          const existing = await destination.file(targetKey).stat();
          if (existing.sha256 === metadata.sha256 && existing.size === metadata.size) continue;
        } catch (error) {
          if ((error as { name?: string }).name !== "NoSuchKey") throw error;
        }
      }
      const path = join(directory, "object");
      await pipeline(Readable.from(file.stream()), createWriteStream(path, { mode: 0o600 }));
      const sha256 = await digest(Bun.file(path).stream());
      const existing = await destination.open(targetKey);
      if (existing) {
        if (!existing.body || await digest(existing.body) !== sha256) throw new Error("Destination contains different data; refusing overwrite");
        continue;
      }
      await destination.write(targetKey, Bun.file(path), { type: metadata.type || "application/octet-stream", sha256 });
      const downloaded = await destination.open(targetKey);
      if (!downloaded?.body || await digest(downloaded.body) !== sha256) throw new Error("Destination checksum verification failed");
      copied++;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  if (page.isTruncated && !continuationToken) throw new Error("Missing list continuation token");
  console.log(JSON.stringify({ execute, objects, copied }));
} while (continuationToken);
