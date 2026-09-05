import { SQL } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const projects = {
  foody: { sourceHost: "foody-database.ocd.internal", database: "foody", sourceKey: "DATABASE_URL", targetKey: "SHARED_DATABASE_URL" },
  sight: { sourceHost: "sight-database.ocd.internal", database: "sight", sourceKey: "DATABASE_URL", targetKey: "SHARED_DATABASE_URL" },
  skyline: { sourceHost: "bc-postgres.ocd.internal", database: "skyline", sourceKey: "DATABASE_URL", targetKey: "SHARED_DATABASE_URL" },
  docs: { sourceHost: "sight-support-docsdb.ocd.internal", database: "sight_docs", sourceKey: "DOCSDB_URL", targetKey: "SHARED_DOCS_DATABASE_URL" },
} as const;
const project = process.argv[2] as keyof typeof projects;
const mode = process.argv[3];
const config = projects[project];
if (!config || !["rehearsal", "final"].includes(mode)) throw new Error("Pass project and rehearsal|final");
let sourceValue = process.env[config.sourceKey];
if (project === "skyline" && !sourceValue) {
  const address = new URL(process.env.POSTGRES_URL!);
  sourceValue = `postgresql://${encodeURIComponent(process.env.POSTGRES_USER || "postgres")}:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@${address.host}/${encodeURIComponent(process.env.POSTGRES_DB || "building_classification")}`;
}
const sourceUrl = new URL(sourceValue!);
const targetUrl = new URL(process.env[config.targetKey]!);
if (sourceUrl.hostname !== config.sourceHost || targetUrl.hostname !== "ocd-shared-postgres.ocd.internal" ||
    targetUrl.pathname !== `/${config.database}` || !targetUrl.username.endsWith("_owner")) throw new Error("Unexpected migration endpoints");
if (mode === "rehearsal") targetUrl.pathname += "_rehearsal";
if (mode === "final" && process.env.DATABASE_CUTOVER_CONFIRMED !== "writers-stopped") throw new Error("Final migration requires stopped writers");

const directory = `/tmp/migration-${project}-${mode}`;
await mkdir(directory, { mode: 0o700 }); // Refuse a repeated execution over an existing dump.
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const source = new SQL({ url: sourceUrl.href, max: 1 });
const target = new SQL({ url: targetUrl.href, max: 1 });
function environment(url: URL, readOnly: boolean) {
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "15",
    PGOPTIONS: readOnly ? "-c default_transaction_read_only=on -c lock_timeout=10000" : "-c lock_timeout=10000",
    ...(url.searchParams.has("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}) };
}
async function command(args: string[], url: URL, readOnly: boolean) {
  const child = Bun.spawn(args, { env: environment(url, readOnly), stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 3600_000);
  try {
    const errors = await new Response(child.stderr).text();
    if (await child.exited) {
      await writeFile(`${directory}/error.log`, errors, { mode: 0o600 });
      throw new Error(`${args[0]} failed; private diagnostics retained`);
    }
  } finally { clearTimeout(timer); }
}
try {
  // The destination must contain only extension-owned bootstrap objects.
  const [{ count }] = await target.unsafe(`SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')`);
  if (Number(count)) throw new Error("Destination already contains application tables; refusing overwrite");
  const tables: Array<{ schema: string; name: string; rows: string }> = [];
  await source.begin("isolation level repeatable read read only", async tx => {
    const [{ snapshot }] = await tx.unsafe("SELECT pg_export_snapshot() AS snapshot");
    if (!/^[0-9A-F-]+$/.test(snapshot)) throw new Error("Invalid snapshot");
    const relations = await tx.unsafe(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' ORDER BY 1,2`);
    for (const row of relations) {
      const [{ count }] = await tx.unsafe(`SELECT count(*)::text FROM ${ident(row.schema)}.${ident(row.name)}`);
      tables.push({ schema: row.schema, name: row.name, rows: count });
    }
    await command(["pg_dump", "-w", "-Fc", "--no-owner", "--no-acl", `--snapshot=${snapshot}`, "-f", `${directory}/database.dump`], sourceUrl, true);
  });
  console.log(JSON.stringify({ event: "snapshot_complete", project, mode, tables: tables.length }));
  const listing = Bun.spawn(["pg_restore", "--list", `${directory}/database.dump`], { stdout: "pipe", stderr: "ignore" });
  const toc = await new Response(listing.stdout).text();
  if (await listing.exited) throw new Error("Cannot inspect dump contents");
  // These schemas are installed by the administrator with their extensions.
  // Keep every data entry, including extension-owned PGMQ queue tables.
  await writeFile(`${directory}/restore.list`, toc.split("\n").filter(line => !/^\d+; \d+ \d+ SCHEMA - (public|pgmq|topology) /.test(line)).join("\n"), { mode: 0o600 });
  await command(["pg_restore", "-w", "--use-list", `${directory}/restore.list`, "--no-owner", "--no-acl", "--no-comments", "--no-security-labels", "--exit-on-error", "-d", decodeURIComponent(targetUrl.pathname.slice(1)), `${directory}/database.dump`], targetUrl, false);
  for (const table of tables) {
    const [{ count }] = await target.unsafe(`SELECT count(*)::text FROM ${ident(table.schema)}.${ident(table.name)}`);
    if (count !== table.rows) throw new Error("Restored table row count mismatch");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(`${directory}/database.dump`)) hash.update(chunk);
  const result = { project, mode, database: targetUrl.pathname.slice(1), tables: tables.length, sha256: hash.digest("hex"), completedAt: new Date().toISOString() };
  await writeFile(`${directory}/verified.json`, JSON.stringify({ ...result, counts: tables }), { mode: 0o600 });
  await writeFile("/tmp/migration-complete", JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify({ event: "database_migration_verified", ...result }));
} catch (error) {
  await writeFile("/tmp/migration-failed", "failed");
  console.error("Migration failed; private diagnostics retained for inspection.");
} finally { await source.close(); await target.close(); }
for (;;) await Bun.sleep(60_000);
