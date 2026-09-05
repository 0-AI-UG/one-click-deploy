import { writeFile } from "node:fs/promises";

const mode = process.argv[2];
if (mode !== "media" && mode !== "backups") throw new Error("MIGRATION_MODE must be media or backups");
const media = mode === "media";
const env = {
  ...process.env,
  SOURCE_S3_BUCKET: media ? process.env.MEDIA_S3_BUCKET : process.env.BACKUP_S3_BUCKET,
  SOURCE_S3_ENDPOINT: media ? process.env.MEDIA_S3_ENDPOINT : process.env.BACKUP_S3_ENDPOINT,
  SOURCE_S3_REGION: (media ? process.env.MEDIA_S3_REGION : process.env.BACKUP_S3_REGION) || (media ? "auto" : "hel1"),
  SOURCE_S3_ACCESS_KEY_ID: media ? process.env.MEDIA_S3_ACCESS_KEY_ID : process.env.S3_ACCESS_KEY_ID,
  SOURCE_S3_SECRET_ACCESS_KEY: media ? process.env.MEDIA_S3_SECRET_ACCESS_KEY : process.env.S3_SECRET_ACCESS_KEY,
  OCD_STORAGE_TOKEN: media ? process.env.OCD_MEDIA_STORAGE_TOKEN : process.env.OCD_LEGACY_BACKUP_STORAGE_TOKEN,
  SOURCE_PREFIX: "",
};
const child = Bun.spawn(["bun", "scripts/migrate-object-storage.ts", "--execute"], { env, stdout: "inherit", stderr: "inherit" });
if (await child.exited) {
  await writeFile("/tmp/migration-failed", mode);
  throw new Error("Storage migration failed; source objects were retained");
}
await writeFile("/tmp/migration-complete", JSON.stringify({ mode, completedAt: new Date().toISOString() }));
console.log(JSON.stringify({ event: "migration_completed", mode }));
// Keep the temporary job inspectable until the operator verifies and removes it.
for (;;) await Bun.sleep(60_000);
