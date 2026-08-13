import { get, post } from "../api.ts";
import { BOLD, DIM, GREEN, RESET, table } from "../format.ts";

type GcInventory = {
  server: { id: number; name: string; ipv4: string };
  images: Array<{ category: string; id: string; size_bytes: number; refs: string[] }>;
  reclaimable_image_bytes: number;
  reclaimable_ocd_image_bytes: number;
  reclaimable_foreign_image_bytes: number;
  buildkit_reclaimable_bytes: number | null;
  buildkit_reclaimable_display: string;
  buildkit_policy: string;
  size_caveat: string;
  free_bytes_delta: number;
  reclaimed_bytes: number;
  removed_image_ids: string[];
  skipped_image_ids: string[];
  executed: boolean;
};

function formatSize(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : "0 MiB";
}

function formatSignedSize(bytes: number): string {
  return `${bytes >= 0 ? "+" : "-"}${formatSize(Math.abs(bytes))}`;
}

export async function gc(args: string[]): Promise<void> {
  let execute = false;
  let server = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") execute = true;
    else if (arg.startsWith("--server=")) server = arg.slice(9);
    else if (arg === "--server") server = args[++i] || "";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.includes("--server") && !server) throw new Error("--server requires a name, ID, or IP");
  const query = server ? `?server=${encodeURIComponent(server)}` : "";
  const rows = execute
    ? await post<GcInventory[]>(`/api/gc${query}`, {})
    : await get<GcInventory[]>(`/api/gc${query}`);

  for (const row of rows) {
    console.log(`\n${BOLD}${row.server.name}${RESET} ${DIM}${row.server.ipv4}${RESET}`);
    table(
      ["CLASS", "IMAGE", "SIZE", "REFERENCES"],
      row.images.map((image) => [
        image.category,
        image.id.replace(/^sha256:/, "").slice(0, 12),
        formatSize(image.size_bytes),
        image.refs.join(", ") || "<none>",
      ]),
    );
    console.log(`${DIM}${row.size_caveat}${RESET}`);
    console.log(`${DIM}BuildKit reclaimable: ${row.buildkit_reclaimable_display} (${row.buildkit_policy})${RESET}`);
    if (execute) {
      console.log(
        `${GREEN}GC completed: ${formatSize(row.reclaimed_bytes)} observed reclaimed ` +
          `(free-space delta ${formatSignedSize(row.free_bytes_delta)}; ` +
          `${row.removed_image_ids.length} images removed, ${row.skipped_image_ids.length} safely skipped)${RESET}`,
      );
    } else {
      console.log(
        `${DIM}Dry run: ${formatSize(row.reclaimable_ocd_image_bytes)} OCD + ` +
          `${formatSize(row.reclaimable_foreign_image_bytes)} unused foreign image data identified${RESET}`,
      );
    }
  }
  if (!execute) console.log(`\n${DIM}No data was removed. Re-run with --execute to reclaim safe assets.${RESET}`);
}
