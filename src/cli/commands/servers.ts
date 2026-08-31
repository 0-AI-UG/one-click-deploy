import { del, get, patch, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { webConfirm, withWebConfirmation } from "../confirm.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";

interface Server {
  id: number;
  name: string;
  provider_id: string;
  provider?: "hetzner" | "external";
  ownership?: "managed" | "connected";
  management_address?: string;
  private_ipv4?: string;
  ipv4: string;
  type: string;
  location: string;
  status?: string;
  pool?: string;
  apps?: { id: number; name: string }[];
}

interface HostProbe {
  uptime_seconds: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_cores: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  processes: number | null;
  ports: Array<{ proto: string; address: string; port: number; process: string }>;
  net: { iface: string; rx_bytes: number; tx_bytes: number } | null;
  error: string | null;
}

interface ServerDetail extends Server {
  status: string;
  ipv6: string;
  private_ipv4: string;
  created_at: string;
  monthly_eur: number | null;
  currency: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  replicas: Array<{ id: number; app_name: string; container_name: string; status: string; cpu_percent: number; memory_percent: number }>;
  host: HostProbe;
}

export type ServerCreateOptions = { serverType: string; location: string; name?: string };

export function parseServerCreateArgs(
  args: string[],
): { ok: true; value: ServerCreateOptions } | { ok: false; error: string } {
  let serverType = "";
  let location = "";
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--type=")) serverType = arg.slice(7);
    else if (arg === "--type") serverType = args[++i] || "";
    else if (arg.startsWith("--location=")) location = arg.slice(11);
    else if (arg === "--location") location = args[++i] || "";
    else if (arg.startsWith("--name=")) name = arg.slice(7);
    else if (arg === "--name") name = args[++i] || "";
    else return { ok: false, error: `Unknown option: ${arg}` };
  }
  if (!serverType) return { ok: false, error: "--type is required" };
  if (!location) return { ok: false, error: "--location is required" };
  return { ok: true, value: { serverType, location, ...(name ? { name } : {}) } };
}

async function listServers(): Promise<void> {
  const list = await get<Server[]>("/api/servers");
  table(
    ["ID", "NAME", "IP", "PROVIDER", "OWNERSHIP", "POOL", "APPS"],
    list.map((s) => [
      String(s.id),
      s.name,
      s.ipv4,
      s.provider || "external",
      s.ownership || "connected",
      s.pool || "general",
      s.apps?.map((a) => a.name).join(", ") || "-",
    ]),
  );
}

async function resolveServer(ref: string): Promise<Server> {
  const list = await get<Server[]>("/api/servers");
  const found = /^\d+$/.test(ref)
    ? list.find((server) => server.id === Number(ref))
    : list.find((server) =>
        server.name.toLowerCase() === ref.toLowerCase() ||
        server.ipv4 === ref ||
        server.provider_id === ref
      );
  if (found) return found;
  console.error(`${RED}Server not found: ${ref}${RESET}`);
  console.error(`Available: ${list.map((server) => server.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function fmtPct(value: number | null): string {
  return value == null ? "-" : `${value.toFixed(1)}%`;
}

function fmtDuration(value: number | null): string {
  if (value == null) return "-";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function showServer(ref: string, diagnosticsOnly = false): Promise<void> {
  const server = await resolveServer(ref);
  const detail = await get<ServerDetail>(`/api/resources/servers/${server.id}`);
  const host = detail.host;
  console.log(`${BOLD}${detail.name}${RESET}  ${colorStatus(detail.status)}  ${DIM}#${detail.id}${RESET}`);
  console.log(`${DIM}Provider:${RESET} ${detail.provider || "external"}${detail.provider_id ? ` (${detail.provider_id})` : ""}  ${DIM}Ownership:${RESET} ${detail.ownership || "connected"}  ${DIM}Pool:${RESET} ${detail.pool || "general"}`);
  console.log(`${DIM}Network:${RESET} ${detail.ipv4}${detail.private_ipv4 ? ` / ${detail.private_ipv4}` : ""}`);
  console.log(`${DIM}Usage:${RESET} CPU ${fmtPct(detail.cpu_percent)}  memory ${fmtPct(detail.memory_percent)}  disk ${detail.disk_free_gb ?? "-"}/${detail.disk_total_gb ?? "-"} GB free`);
  console.log(`${DIM}Cost:${RESET} ${detail.monthly_eur == null ? "-" : `${detail.currency} ${detail.monthly_eur.toFixed(2)}/month`}`);

  console.log(`\n${BOLD}Host diagnostics${RESET}`);
  if (host.error) console.log(`${RED}${host.error}${RESET}`);
  console.log(`Uptime ${fmtDuration(host.uptime_seconds)}  load ${host.load1 ?? "-"}/${host.load5 ?? "-"}/${host.load15 ?? "-"}  CPUs ${host.cpu_cores ?? "-"}  processes ${host.processes ?? "-"}`);
  console.log(`Memory ${host.mem_used_mb ?? "-"}/${host.mem_total_mb ?? "-"} MB  swap ${host.swap_used_mb ?? "-"}/${host.swap_total_mb ?? "-"} MB`);
  if (host.net) console.log(`Network ${host.net.iface}: rx ${host.net.rx_bytes} B, tx ${host.net.tx_bytes} B`);
  if (host.ports.length) {
    table(
      ["PROTO", "ADDRESS", "PORT", "PROCESS"],
      host.ports.map((port) => [port.proto, port.address, String(port.port), port.process || "-"]),
    );
  }
  if (diagnosticsOnly) return;

  console.log(`\n${BOLD}Replicas${RESET}`);
  table(
    ["ID", "APP", "CONTAINER", "STATUS", "CPU", "MEM"],
    detail.replicas.map((replica) => [
      String(replica.id),
      replica.app_name,
      replica.container_name,
      colorStatus(replica.status),
      fmtPct(replica.cpu_percent),
      fmtPct(replica.memory_percent),
    ]),
  );
}

async function createServer(args: string[]): Promise<void> {
  const parsed = parseServerCreateArgs(args);
  if (!parsed.ok) {
    console.error(`${RED}${parsed.error}${RESET}`);
    console.error("Usage: ocd servers create --type=<type> --location=<location> [--name=<name>]");
    process.exit(1);
  }
  const { serverType, location, name } = parsed.value;
  const body = { server_type: serverType, location, name };
  const { op_id } = await withWebConfirmation((headers) =>
    post<{ op_id: number }>("/api/resources/servers", body, headers)
  );
  const result = await followOp(op_id);
  if (!result.ok) throw new Error(result.error || "Server provisioning failed");
  console.log(`${GREEN}Server provisioned.${RESET}`);
}

async function deleteServer(args: string[]): Promise<void> {
  if (args.includes("--yes") || args.includes("-y")) {
    throw new Error("--yes has been removed; approve server deletion in the web UI");
  }
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) {
    console.error("Usage: ocd servers delete <name|id>");
    process.exit(1);
  }
  const server = await resolveServer(ref);
  const confirmation = await webConfirm("delete_server", "server", server.id);
  if (!confirmation) return;
  const result = await del<{ ok: boolean; error?: string; op_id?: number }>(
    `/api/servers/${server.id}`,
    undefined,
    { "X-OCD-Confirmation": confirmation },
  );
  if (!result.ok) throw new Error(result.error || "Server deletion failed");
  if (result.op_id) {
    const op = await followOp(result.op_id);
    if (!op.ok) throw new Error(op.error || "Server deletion failed");
  }
  console.log(
    server.ownership === "connected"
      ? `${GREEN}Server disconnected; the external VPS was not deleted.${RESET}`
      : `${GREEN}Managed server deleted.${RESET}`,
  );
}

function valueFlag(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function printEnrollmentKey(): Promise<void> {
  const result = await get<{ public_key: string }>("/api/servers/enrollment-key");
  console.log(result.public_key);
}

async function connectServer(args: string[]): Promise<void> {
  const name = valueFlag(args, "name");
  const managementAddress = valueFlag(args, "address");
  const privateIpv4 = valueFlag(args, "private-address");
  const sshHostKey = valueFlag(args, "host-key");
  if (!name || !managementAddress || !privateIpv4 || !sshHostKey) {
    throw new Error("Usage: ocd servers connect --name=X --address=X --private-address=X --host-key='X ssh-ed25519 AAAA...' [--pool=general]");
  }
  const result = await post<{ server: Server }>("/api/servers/connect", {
    name,
    management_address: managementAddress,
    private_ipv4: privateIpv4,
    ssh_host_key: sshHostKey,
    ssh_user: valueFlag(args, "ssh-user") || "root",
    ssh_port: Number(valueFlag(args, "ssh-port") || "22"),
    pool: valueFlag(args, "pool") || "general",
  });
  console.log(`${GREEN}Connected ${result.server.name} as an externally owned stateless host.${RESET}`);
}

async function setPool(ref: string, pool: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(pool)) {
    throw new Error("Pool must be a lowercase slug of at most 32 characters");
  }
  const server = await resolveServer(ref);
  await patch(`/api/servers/${server.id}/pool`, { pool });
  console.log(`${GREEN}${server.name} moved to pool ${pool}.${RESET}`);
}

async function metrics(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, { since: { type: "string" } }, { maxPositionals: 1 });
  const ref = parsed.positionals[0];
  const since = positiveIntegerFlag(parsed.flags.since, "since", { defaultValue: 3600 })!;
  const server = ref ? await resolveServer(ref) : undefined;
  const samples = await get<Array<{ server_id: number; cpu_percent: number; memory_percent: number; sampled_at: string }>>(
    `/api/resources/metrics/history?since=${since}`,
  );
  const filtered = server ? samples.filter((sample) => sample.server_id === server.id) : samples;
  table(
    ["SERVER", "CPU", "MEM", "SAMPLED"],
    filtered.map((sample) => [
      server?.name || String(sample.server_id),
      fmtPct(sample.cpu_percent),
      fmtPct(sample.memory_percent),
      sample.sampled_at,
    ]),
  );
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd servers <command>

${BOLD}Commands:${RESET}
  ls                              List servers
  show <name|id>                  Detail, workloads and host diagnostics
  diagnose <name|id>              Host diagnostics
  create --type=X --location=X    Provision a server
  enrollment-key                  Print the public key to install on an external host
  connect --name=X --address=X --private-address=X --host-key='...'  Connect an existing stateless host
  delete <name|id>                Destroy a managed host or disconnect an external host
  refresh                         Refresh provider-backed server inventory
  pool <name|id> <pool>           Change future-placement capacity pool
  metrics [name|id] [--since=N]   Server metric history`);
}

export async function servers(args: string[] = []): Promise<void> {
  const sub = args[0] || "ls";
  const rest = args.slice(1);
  switch (sub) {
    case "ls":
    case "list":
      return listServers();
    case "show":
    case "detail":
      if (!rest[0]) throw new Error("Usage: ocd servers show <name|id>");
      return showServer(rest[0]);
    case "diagnose":
    case "diagnostics":
      if (!rest[0]) throw new Error("Usage: ocd servers diagnose <name|id>");
      return showServer(rest[0], true);
    case "create":
      return createServer(rest);
    case "enrollment-key":
      return printEnrollmentKey();
    case "connect":
      return connectServer(rest);
    case "delete":
    case "remove":
      return deleteServer(rest);
    case "refresh":
      await post("/api/servers/refresh");
      console.log(`${GREEN}Server inventory refreshed.${RESET}`);
      return;
    case "pool":
      if (!rest[0] || !rest[1]) throw new Error("Usage: ocd servers pool <name|id> <pool>");
      return setPool(rest[0], rest[1]);
    case "metrics":
      return metrics(rest);
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`${RED}Unknown servers command: ${sub}${RESET}`);
      usage();
      process.exit(1);
  }
}
