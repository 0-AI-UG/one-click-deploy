import { readFile, writeFile } from "node:fs/promises";

async function patch(path: string, anchor: string, replacement: string, importLine: string) {
  const source = await readFile(path, "utf8");
  if (!source.includes(anchor) || source.includes(importLine)) throw new Error(`Unexpected base source in ${path}`);
  await writeFile(path, importLine + "\n" + source.replace(anchor, replacement));
}
await patch("/app/src/server/routes.ts", "export const apiRoutes = {", `export const apiRoutes = {
  "/api/storage/authorize": { POST: handleStorageAuthorize },
  "/api/admin/storage-grants": { GET: handleStorageGrants, POST: handleStorageGrants, DELETE: handleStorageGrants },`,
  'import { handleStorageAuthorize, handleStorageGrants } from "./routes/storage-access.ts";');
await patch("/app/src/cli/main.ts", "  buckets,", "  buckets,\n  storage,", 'import { storage } from "./commands/storage.ts";');
