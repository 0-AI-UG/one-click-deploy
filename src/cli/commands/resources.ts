import { del, get } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, table } from "../format.ts";
import { webConfirm } from "../confirm.ts";

type ResourceServer = {
  id: number; name: string; provider_id: string; type: string; location: string;
  status: string; replica_count: number; disk_free_gb: number | null;
  disk_total_gb: number | null; monthly_eur: number | null;
};
type ResourceVolume = {
  id: string; name: string; size: number; location: string; server_name: string;
  app_name: string; retired_state: string; retired_from: string; purge_after: string;
  retention_class: "user" | "provisional" | "";
  monthly_eur: number | null;
};
type ResourceInventory = {
  servers: ResourceServer[];
  volumes: ResourceVolume[];
  totals?: { servers: number; volumes: number; total: number; currency: string };
};

function money(value: number | null | undefined, currency = "EUR"): string {
  return value == null ? "-" : `${currency} ${value.toFixed(2)}`;
}

async function inventory(): Promise<ResourceInventory> {
  return get<ResourceInventory>("/api/resources");
}

async function listResources(): Promise<void> {
  const data = await inventory();
  const currency = data.totals?.currency || "EUR";
  if (data.totals) {
    console.log(
      `${BOLD}Estimated monthly cost:${RESET} ${money(data.totals.total, currency)} ` +
      `${DIM}(servers ${money(data.totals.servers, currency)}, volumes ${money(data.totals.volumes, currency)})${RESET}`,
    );
  }
  console.log(`\n${BOLD}Servers${RESET}`);
  table(
    ["ID", "NAME", "TYPE", "LOCATION", "REPLICAS", "DISK FREE", "COST"],
    data.servers.map((server) => [
      String(server.id),
      server.name,
      server.type,
      server.location,
      String(server.replica_count),
      server.disk_free_gb == null ? "-" : `${server.disk_free_gb}/${server.disk_total_gb} GB`,
      money(server.monthly_eur, currency),
    ]),
  );
  console.log(`\n${BOLD}Volumes${RESET}`);
  table(
    ["ID", "NAME", "STATE", "SIZE", "LOCATION", "SERVER", "APP", "COST"],
    data.volumes.map((volume) => [
      volume.id,
      volume.name,
      volume.retired_state
        ? volume.retention_class === "provisional"
          ? `provisional${volume.purge_after ? ` until ${volume.purge_after.slice(0, 10)}` : ""}`
          : `retained${volume.purge_after ? `; review ${volume.purge_after.slice(0, 10)}` : ""}`
        : "attached",
      `${volume.size} GB`,
      volume.location,
      volume.server_name || "-",
      volume.app_name || "-",
      money(volume.monthly_eur, currency),
    ]),
  );
}

async function showVolume(ref: string): Promise<void> {
  const data = await get<{
    id: string; name: string; size: number; location: string; server_name: string | null;
    app_name: string | null; host_path: string | null; monthly_eur: number | null; attached: boolean;
  }>(`/api/resources/volumes/${encodeURIComponent(ref)}`);
  console.log(`${BOLD}${data.name}${RESET}  ${DIM}${data.id}${RESET}`);
  console.log(`State: ${data.attached ? "attached" : "detached"}  Size: ${data.size} GB  Location: ${data.location}`);
  console.log(`Server: ${data.server_name || "-"}  App: ${data.app_name || "-"}  Cost: ${money(data.monthly_eur)}`);
  if (data.host_path) console.log(`Host path: ${data.host_path}`);
}

async function volumeDeletionAudit(): Promise<void> {
  const rows = await get<Array<{
    provider_volume_id: string; provider_volume_name: string; former_resource_name: string;
    retention_state: string; status: string; actor_user_id: string; requested_at: string; error: string;
  }>>("/api/resources/volumes/deletion-audit");
  table(
    ["REQUESTED", "ID", "NAME", "FORMER OWNER", "STATE", "STATUS", "ACTOR", "ERROR"],
    rows.map((row) => [
      row.requested_at,
      row.provider_volume_id,
      row.provider_volume_name,
      row.former_resource_name || "-",
      row.retention_state || "-",
      row.status,
      row.actor_user_id,
      row.error || "-",
    ]),
  );
}

async function deleteResource(args: string[]): Promise<void> {
  if (args.includes("--yes") || args.includes("-y")) {
    throw new Error("--yes has been removed; approve resource deletion in the web UI");
  }
  const type = args[0];
  const id = args[1];
  if (!type || !id || !["server", "volume"].includes(type)) {
    throw new Error("Usage: ocd resources delete <server|volume> <provider-id>");
  }
  let headers: Record<string, string> | undefined;
  if (type === "volume") {
    const confirmation = await webConfirm("delete_volume", "volume", id);
    if (!confirmation) {
      console.log("Aborted.");
      return;
    }
    headers = { "X-OCD-Confirmation": confirmation };
  } else {
    const inventory = await get<ResourceInventory>("/api/resources");
    const server = inventory.servers.find((row) => row.provider_id === id || String(row.id) === id);
    if (!server) throw new Error(`Server not found: ${id}`);
    const confirmation = await webConfirm("delete_server", "server", server.id);
    if (!confirmation) return;
    headers = { "X-OCD-Confirmation": confirmation };
  }
  const result = await del<{ ok: boolean; error?: string; op_id?: number }>(
    `/api/resources/${type}/${encodeURIComponent(id)}`,
    undefined,
    headers,
  );
  if (!result.ok) throw new Error(result.error || `${type} deletion failed`);
  if (result.op_id) {
    const op = await followOp(result.op_id);
    if (!op.ok) throw new Error(op.error || `${type} deletion failed`);
  }
  console.log(`${GREEN}${type} deleted.${RESET}`);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

async function listVolumeFiles(volumeId: string, path: string): Promise<void> {
  const result = await get<{
    host_path: string;
    path: string;
    entries: Array<{ name: string; type: string; size: number; mtime: number }>;
  }>(
    `/api/resources/volumes/${encodeURIComponent(volumeId)}/files?path=${encodeURIComponent(path)}`,
  );
  console.log(`${DIM}${result.host_path}${path ? `/${path}` : ""}${RESET}`);
  table(
    ["TYPE", "NAME", "SIZE", "MODIFIED"],
    result.entries.map((entry) => [
      entry.type === "d" ? "dir" : entry.type === "l" ? "link" : "file",
      entry.name,
      entry.type === "d" ? "-" : formatBytes(entry.size),
      entry.mtime ? new Date(entry.mtime * 1000).toISOString() : "-",
    ]),
  );
}

async function readVolumeFile(volumeId: string, path: string): Promise<void> {
  if (!path) throw new Error("Usage: ocd volumes cat <provider-volume-id> <path>");
  const result = await get<{
    size: number; truncated: boolean; binary: boolean; content: string | null; max_bytes: number;
  }>(
    `/api/resources/volumes/${encodeURIComponent(volumeId)}/file?path=${encodeURIComponent(path)}`,
  );
  if (result.binary) throw new Error("Refusing to print a binary file");
  process.stdout.write(result.content || "");
  if (result.content && !result.content.endsWith("\n")) process.stdout.write("\n");
  if (result.truncated) {
    console.error(`${DIM}[truncated at ${formatBytes(result.max_bytes)}; file is ${formatBytes(result.size)}]${RESET}`);
  }
}

function volumeUsage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd volumes <command>

${BOLD}Commands:${RESET}
  list                                  List provider volumes and retention state
  show <provider-volume-id>             Show volume ownership, mount and cost
  audit                                 Show the durable permanent-deletion audit
  ls <id> [path]                        Browse an attached volume
  cat <id> <path>                       Read a text file (max 256 KiB)
  delete <id>                           Permanently destroy an unused volume (browser approval)`);
}

export async function volumes(args: string[] = []): Promise<void> {
  const sub = args[0] || "list";
  if (sub === "list" || sub === "ls-all") {
    const data = await inventory();
    table(
      ["ID", "NAME", "STATE", "SIZE", "LOCATION", "SERVER", "APP"],
      data.volumes.map((volume) => [
        volume.id,
        volume.name,
        volume.retired_state ? "retained" : (volume.server_name ? "attached" : "detached"),
        `${volume.size} GB`,
        volume.location,
        volume.server_name || "-",
        volume.app_name || "-",
      ]),
    );
    return;
  }
  if (sub === "show" || sub === "status") {
    if (!args[1]) throw new Error("Usage: ocd volumes show <provider-volume-id>");
    return showVolume(args[1]);
  }
  if (sub === "audit" || sub === "deletion-audit") return volumeDeletionAudit();
  if (sub === "ls" || sub === "files") {
    if (!args[1]) throw new Error("Usage: ocd volumes ls <provider-volume-id> [path]");
    return listVolumeFiles(args[1], args[2] || "");
  }
  if (sub === "cat" || sub === "read") {
    if (!args[1] || !args[2]) throw new Error("Usage: ocd volumes cat <provider-volume-id> <path>");
    return readVolumeFile(args[1], args[2]);
  }
  if (sub === "delete" || sub === "remove") {
    if (!args[1]) throw new Error("Usage: ocd volumes delete <provider-volume-id>");
    return deleteResource(["volume", args[1], ...args.slice(2)]);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") return volumeUsage();
  throw new Error(`Unknown volume command: ${sub}`);
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd resources <command>

${BOLD}Commands:${RESET}
  ls                              Inventory and estimated monthly cost
  volume <provider-id>            Volume detail
  volumes <command>               Volume inspection, files, and deletion
  delete <server|volume> <id>     Permanently delete an unused provider resource`);
}

export async function resources(args: string[] = []): Promise<void> {
  const sub = args[0] || "ls";
  switch (sub) {
    case "ls":
    case "list":
      return listResources();
    case "volume":
      if (!args[1]) throw new Error("Usage: ocd resources volume <provider-id>");
      return showVolume(args[1]);
    case "volumes":
      return volumes(args.slice(1));
    case "delete":
    case "remove":
      return deleteResource(args.slice(1));
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`${RED}Unknown resources command: ${sub}${RESET}`);
      usage();
      process.exit(1);
  }
}
