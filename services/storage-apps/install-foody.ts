// Apply only storage integration to the pinned release, preserving concurrent
// source refactors and unrelated runtime configuration.
const root = "/app/packages/server/src/infrastructure/storage/";
for (const name of ["configured-object-storage.ts", "ocd-storage.ts"]) {
  let source = await Bun.file(root + name).text();
  for (const stem of ["local-storage", "s3-storage", "storage"]) {
    if (await Bun.file(root + stem + "-adapter.ts").exists()) {
      source = source.replaceAll(`"./${stem}"`, `"./${stem}-adapter"`);
    }
  }
  await Bun.write(root + name, source);
}
const api = "/app/services/api/src/bootstrap/process-config.ts";
if (await Bun.file(api).exists()) {
  let source = await Bun.file(api).text();
  if (!source.includes("OCD_STORAGE_URL")) {
    if (!source.includes('  STORAGE_DRIVER: stringValue(')) throw new Error("Unexpected API config layout");
    source = source.replace('  readonly STORAGE_DRIVER:', '  readonly OCD_STORAGE_URL?: string;\n  readonly OCD_STORAGE_TOKEN?: string;\n  readonly STORAGE_DRIVER:')
      .replace('  STORAGE_DRIVER: stringValue(', '  OCD_STORAGE_URL: optionalString("OCD_STORAGE_URL"),\n  OCD_STORAGE_TOKEN: optionalString("OCD_STORAGE_TOKEN"),\n  STORAGE_DRIVER: stringValue(');
    await Bun.write(api, source);
  }
}
const worker = "/app/services/worker/src/bootstrap/worker-config.ts";
if (await Bun.file(worker).exists()) {
  let source = await Bun.file(worker).text();
  if (!source.includes("OCD_STORAGE_URL")) {
    if (!source.includes('    storage: Object.freeze({')) throw new Error("Unexpected worker config layout");
    source = source.replace('    storage: Object.freeze({', '    storage: Object.freeze({\n      OCD_STORAGE_URL: optionalString(environment, "OCD_STORAGE_URL"),\n      OCD_STORAGE_TOKEN: optionalString(environment, "OCD_STORAGE_TOKEN"),');
    await Bun.write(worker, source);
  }
}
