import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checksum, encryptArchive } from "./archive.ts";

type Environment = Record<string, string | undefined>;
export interface BackupStorage {
  upload(key: string, file: string, contentType: string): Promise<void>;
  download(key: string, file: string): Promise<void>;
}

export function postgresEnvironment(raw: string): Environment {
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("Invalid PostgreSQL URL");
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: "postgres",
    PGCONNECT_TIMEOUT: "15", PGOPTIONS: "-c default_transaction_read_only=on -c lock_timeout=10000",
    ...(url.searchParams.has("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}) };
}

async function command(args: string[], env: Environment): Promise<string> {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3600_000);
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error(`${args[0]} failed`);
    return output.trim();
  } finally { clearTimeout(timeout); }
}

const sql = (query: string, env: Environment) => command(["psql", "-X", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], env);

export async function buildArchive(directory: string, env: Environment, passphrase: string): Promise<{ file: string; databases: number }> {
  const databases: string[] = JSON.parse(await sql("SELECT coalesce(json_agg(datname ORDER BY datname), '[]') FROM pg_database WHERE NOT datistemplate AND datallowconn", env));
  if (!databases.length) throw new Error("No databases found");
  const manifest = { format: 1, createdAt: new Date().toISOString(), serverVersion: await sql("SHOW server_version", env),
    databases: [] as Array<{ name: string; file: string; sha256: string; extensions: unknown }>, rolesSha256: "" };
  for (const [index, name] of databases.entries()) {
    const file = `database-${String(index).padStart(4, "0")}.dump`;
    const dbEnv = { ...env, PGDATABASE: name };
    const unsafeQueues = await sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
      "JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e' " +
      "JOIN pg_extension e ON e.oid=d.refobjid WHERE n.nspname='pgmq' AND e.extname='pgmq' " +
      "AND c.relkind IN ('r','p') AND NOT c.oid=ANY(coalesce(e.extconfig,'{}'::oid[]))", dbEnv);
    if (Number(unsafeQueues) > 0) throw new Error("PGMQ tables are excluded from logical backups; migrate queue data before enabling this backup");
    await command(["pg_dump", "-w", "--format=custom", "--file", join(directory, file)], dbEnv);
    await command(["pg_restore", "--list", join(directory, file)], dbEnv);
    const extensions = JSON.parse(await sql("SELECT json_agg(e) FROM (SELECT extname, extversion FROM pg_extension ORDER BY extname) e", dbEnv));
    manifest.databases.push({ name, file, sha256: await checksum(join(directory, file)), extensions });
  }
  await writeFile(join(directory, "roles.sql"), await command(["pg_dumpall", "-w", "--roles-only", "--no-role-passwords"], env), { mode: 0o600 });
  manifest.rolesSha256 = await checksum(join(directory, "roles.sql"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await command(["tar", "-cf", join(directory, "cluster.tar"), "-C", directory,
    "roles.sql", "manifest.json", ...manifest.databases.map(db => db.file)], env);
  const file = join(directory, "cluster.ocdpg");
  await encryptArchive(join(directory, "cluster.tar"), file, passphrase);
  return { file, databases: databases.length };
}

export async function publishBackup(storage: BackupStorage, file: string, databases: number, prefix: string, directory: string): Promise<void> {
  if (!prefix || prefix.startsWith("/") || prefix.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid backup prefix");
  const run = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const base = `${prefix.replace(/\/$/, "")}/${run}`;
  const key = `${base}/cluster.ocdpg`;
  const digest = await checksum(file);
  await storage.upload(key, file, "application/octet-stream");
  const downloaded = join(directory, "downloaded.ocdpg");
  await storage.download(key, downloaded);
  if (await checksum(downloaded) !== digest) throw new Error("Uploaded backup checksum mismatch");
  const record = { format: 1, key, sha256: digest, sizeBytes: Bun.file(file).size, databases, completedAt: new Date().toISOString() };
  const complete = join(directory, "complete.json");
  await writeFile(complete, JSON.stringify(record));
  await storage.upload(`${base}/complete.json`, complete, "application/json");
  await writeFile("/tmp/backup-success", String(Date.now()));
  console.log(JSON.stringify({ event: "backup_completed", ...record }));
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

/** Transfer object bytes directly using URLs authorized by OCD. */
export function ocdStorage(endpoint: string, token: string): BackupStorage {
  if (new URL(endpoint).protocol !== "https:") throw new Error("OCD storage requires HTTPS");
  async function authorize(method: string, key: string, contentType?: string): Promise<string> {
    const response = await fetch(endpoint, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, key, contentType, expiresIn: 3600 }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("OCD storage authorization failed");
    const result = await response.json() as { url: string };
    if (new URL(result.url).protocol !== "https:") throw new Error("Invalid storage URL");
    return result.url;
  }
  return {
    async upload(key, file, contentType) {
      const response = await fetch(await authorize("PUT", key, contentType), { method: "PUT", body: Bun.file(file),
        headers: { "content-type": contentType }, redirect: "error", signal: AbortSignal.timeout(3600_000) });
      if (!response.ok) throw new Error("Backup upload failed");
      await response.body?.cancel();
    },
    async download(key, file) {
      const response = await fetch(await authorize("GET", key), { redirect: "error", signal: AbortSignal.timeout(3600_000) });
      if (!response.ok) throw new Error("Backup download failed");
      if (!response.body) throw new Error("Backup download has no body");
      await pipeline(Readable.from(response.body), createWriteStream(file, { mode: 0o600 }));
    },
  };
}

if (import.meta.main) {
  const interval = Number(process.env.BACKUP_INTERVAL_SECONDS ?? 21600);
  if (!Number.isInteger(interval) || interval < 300) throw new Error("Backup interval must be at least 300 seconds");
  if (process.argv.includes("--health")) {
    const lastSuccess = Number(await Bun.file("/tmp/backup-success").text().catch(() => "0"));
    const started = Number(await Bun.file("/tmp/backup-started").text().catch(() => "0"));
    const healthy = lastSuccess > 0 ? Date.now() - lastSuccess < (interval + 1800) * 1000
      : started > 0 && Date.now() - started < 1800_000;
    process.exit(healthy ? 0 : 1);
  }
  const env = postgresEnvironment(required("BACKUP_DATABASE_URL"));
  const key = required("BACKUP_ENCRYPTION_KEY");
  if (key.length < 32) throw new Error("Backup encryption key must have at least 32 characters");
  const storage = ocdStorage(required("OCD_STORAGE_URL"), required("OCD_STORAGE_TOKEN"));
  await writeFile("/tmp/backup-started", String(Date.now()));
  for (;;) {
    const directory = await mkdtemp(join(tmpdir(), "ocd-pg-backup-"));
    let delay = interval;
    try {
      const archive = await buildArchive(directory, env, key);
      await publishBackup(storage, archive.file, archive.databases, process.env.BACKUP_PREFIX ?? "shared-postgres", directory);
    } catch {
      console.error(JSON.stringify({ event: "backup_failed", retrySeconds: 300 }));
      delay = 300;
    } finally { await rm(directory, { recursive: true, force: true }); }
    await Bun.sleep(delay * 1000);
  }
}
