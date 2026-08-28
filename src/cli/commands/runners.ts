import { del, get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";

type Server = { id: number; name: string; ipv4: string; status?: string };
type Worker = {
  id: number;
  name: string;
  worker_version: string;
  architecture: string;
  status: string;
  last_error: string;
  disk_free_bytes?: number;
  server: Server | null;
};
type Source = {
  id: number;
  repository: string;
  branch: string;
  webhook_enabled: number;
  webhook_url: string;
  webhook_secret_configured: boolean;
  last_commit: string;
  last_status: string;
  last_error: string;
};

function valueFlag(args: string[], name: string): string | undefined {
  const equal = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function formatBytes(value?: number): string {
  if (!value) return "-";
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

async function resolveServer(ref: string): Promise<Server> {
  const servers = await get<Server[]>("/api/servers");
  const server = /^\d+$/.test(ref)
    ? servers.find((candidate) => candidate.id === Number(ref))
    : servers.find((candidate) => candidate.name.toLowerCase() === ref.toLowerCase() || candidate.ipv4 === ref);
  if (!server) throw new Error(`Server not found: ${ref}`);
  return server;
}

async function listWorkers(): Promise<void> {
  const workers = await get<Worker[]>("/api/runners");
  table(
    ["ID", "NAME", "SERVER", "STATUS", "VERSION", "ARCH", "DISK FREE"],
    workers.map((worker) => [
      String(worker.id), worker.name, worker.server?.name || "missing",
      colorStatus(worker.status), worker.worker_version || "-", worker.architecture || "-",
      formatBytes(worker.disk_free_bytes),
    ]),
  );
  for (const worker of workers.filter((candidate) => candidate.last_error)) {
    console.log(`${RED}${worker.name}:${RESET} ${worker.last_error}`);
  }
}

async function installWorker(args: string[]): Promise<void> {
  const serverRef = valueFlag(args, "server");
  const tokenEnv = valueFlag(args, "removal-token-env") || "GITHUB_RUNNER_REMOVE_TOKEN";
  if (!serverRef) throw new Error("Usage: ocd runners install --server=<name|id> [--name=X] [--removal-token-env=GITHUB_RUNNER_REMOVE_TOKEN]");
  const server = await resolveServer(serverRef);
  const result = await post<{ op_id: number }>("/api/runners", {
    server_id: server.id,
    name: valueFlag(args, "name"),
    removal_token: process.env[tokenEnv]?.trim() || undefined,
  });
  const operation = await followOp(result.op_id);
  if (!operation.ok) throw new Error(operation.error || "Build-worker installation failed");
  console.log(`${GREEN}OCD build worker installed on ${server.name}.${RESET}`);
  console.log("Deploy a build manifest once, then configure the source shown by `ocd runners sources` as a GitHub push webhook.");
}

async function resolveWorker(ref: string): Promise<Worker> {
  const workers = await get<Worker[]>("/api/runners");
  const worker = /^\d+$/.test(ref)
    ? workers.find((candidate) => candidate.id === Number(ref))
    : workers.find((candidate) => candidate.name.toLowerCase() === ref.toLowerCase());
  if (!worker) throw new Error(`Build worker not found: ${ref}`);
  return worker;
}

async function removeWorker(args: string[]): Promise<void> {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("Usage: ocd runners remove <name|id>");
  const worker = await resolveWorker(ref);
  const result = await del<{ op_id: number }>(`/api/runners/${worker.id}`);
  const operation = await followOp(result.op_id);
  if (!operation.ok) throw new Error(operation.error || "Build-worker removal failed");
  console.log(`${GREEN}Build worker ${worker.name} removed; its server was retained.${RESET}`);
}

async function listSources(): Promise<void> {
  const sources = await get<Source[]>("/api/build-sources");
  table(
    ["ID", "REPOSITORY", "BRANCH", "WEBHOOK", "LAST COMMIT", "STATUS"],
    sources.map((source) => [
      String(source.id), source.repository.replace(/^https:\/\/github\.com\//, ""), source.branch,
      source.webhook_enabled ? (source.webhook_secret_configured ? "ready" : "secret missing") : "disabled",
      source.last_commit ? source.last_commit.slice(0, 12) : "-", colorStatus(source.last_status || "idle"),
    ]),
  );
  for (const source of sources) {
    console.log(`\n${BOLD}${source.id}: ${source.repository}#${source.branch}${RESET}`);
    console.log(`URL: ${source.webhook_url}`);
    if (source.last_error) console.log(`${RED}Last error:${RESET} ${source.last_error}`);
  }
}

async function webhookSecret(args: string[]): Promise<void> {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref || !/^\d+$/.test(ref)) throw new Error("Usage: ocd runners webhook-secret <source-id>");
  const result = await post<{ webhook_url: string; secret: string }>(`/api/build-sources/${Number(ref)}/webhook-secret`, {});
  console.log(`${BOLD}Payload URL:${RESET} ${result.webhook_url}`);
  console.log(`${BOLD}Content type:${RESET} application/json`);
  console.log(`${BOLD}Secret (shown once):${RESET} ${result.secret}`);
  console.log(`${DIM}Select only the GitHub push event. Rotating this value invalidates the previous secret immediately.${RESET}`);
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd runners <command>

${BOLD}Commands:${RESET}
  ls
      List OCD BuildKit workers and disk headroom.

  install --server=X [--name=X]
      [--removal-token-env=GITHUB_RUNNER_REMOVE_TOKEN]
      Reserve an empty server and install the OCD build worker. The one-time
      removal token is needed only when converting an existing Actions runner.

  remove <name|id>
      Remove the worker and restore its server's previous capacity pool.

  sources
      List repository/branch webhook sources created by manifest deploys.

  webhook-secret <source-id>
      Rotate and show a GitHub webhook URL and HMAC secret once.

${DIM}The worker checks out the exact push SHA, uses BuildKit to push an immutable
digest, then OCD reconciles the committed manifest or stack.${RESET}`);
}

export async function runners(args: string[] = []): Promise<void> {
  const subcommand = args[0] || "ls";
  const rest = args.slice(1);
  switch (subcommand) {
    case "ls":
    case "list": return listWorkers();
    case "install": return installWorker(rest);
    case "remove":
    case "delete": return removeWorker(rest);
    case "sources": return listSources();
    case "webhook-secret": return webhookSecret(rest);
    case "help":
    case "--help":
    case "-h": return usage();
    default:
      console.error(`${RED}Unknown runners command: ${subcommand}${RESET}`);
      usage();
      process.exit(1);
  }
}
