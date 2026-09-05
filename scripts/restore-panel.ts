#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { restoreArchive } from "../src/engine/panel-protection/restore.ts";
import { getObject, isS3Endpoint, isS3Region } from "../src/engine/object-storage/s3.ts";

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { from: { type: "string" }, file: { type: "string" }, "data-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("bun run scripts/restore-panel.ts --from s3://bucket/path.ocdb --data-dir /new/panel-data\nOr --file backup.ocdb instead of --from.\nSet OCD_RECOVERY_KEY; for S3 also set OCD_S3_ENDPOINT, OCD_S3_REGION, OCD_S3_ACCESS_KEY, OCD_S3_SECRET_KEY.\nStop the original panel first. Destination must not exist. Restored automation starts paused.");
    return;
  }
  if (!values["data-dir"] || !!values.from === !!values.file) throw new Error("Specify --data-dir and exactly one of --from or --file (see --help)");
  const recoveryKey = process.env.OCD_RECOVERY_KEY || "";
  if (!/^[a-f0-9]{64}$/.test(recoveryKey)) throw new Error("Set OCD_RECOVERY_KEY to your saved recovery key");
  let bytes: Buffer;
  if (values.file) bytes = readFileSync(values.file);
  else {
    const source = new URL(values.from!);
    if (source.protocol !== "s3:" || source.username || source.password || source.search || source.hash) throw new Error("Expected s3://bucket/path.ocdb");
    const credentials = { endpoint: process.env.OCD_S3_ENDPOINT || "", region: process.env.OCD_S3_REGION || "", accessKey: process.env.OCD_S3_ACCESS_KEY || "", secretKey: process.env.OCD_S3_SECRET_KEY || "" };
    if (!isS3Endpoint(credentials.endpoint) || !isS3Region(credentials.region) || !credentials.accessKey || !credentials.secretKey) throw new Error("Set valid OCD_S3_ENDPOINT, OCD_S3_REGION, OCD_S3_ACCESS_KEY, and OCD_S3_SECRET_KEY");
    bytes = await getObject(source.hostname, decodeURIComponent(source.pathname.slice(1)), credentials);
  }
  const result = restoreArchive(bytes, recoveryKey, values["data-dir"]);
  console.log(`Panel backup from ${result.createdAt} restored.\nMount the new directory as OCD_DATA_DIR and start the matching OCD release. Do not supply a different JWT_SECRET.\nAutomation is paused. Open Admin → Panel to verify server access and resume.\nBackup image: ${result.image || "not recorded (use the release that created this backup)"}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Restore failed"); process.exitCode = 1; });
