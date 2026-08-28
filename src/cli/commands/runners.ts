import { del, get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";

type Server = { id: number; name: string; ipv4: string; status?: string };
type Runner = {
  id: number;
  name: string;
  scope_url: string;
  labels: string;
  runner_version: string;
  architecture: string;
  status: string;
  last_error: string;
  disk_free_bytes?: number;
  server: Server | null;
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

async function listRunners(): Promise<void> {
  const runners = await get<Runner[]>("/api/runners");
  table(
    ["ID", "NAME", "SERVER", "SCOPE", "STATUS", "VERSION", "ARCH", "DISK FREE"],
    runners.map((runner) => [
      String(runner.id),
      runner.name,
      runner.server?.name || "missing",
      runner.scope_url.replace("https://github.com/", ""),
      colorStatus(runner.status),
      runner.runner_version || "-",
      runner.architecture || "-",
      formatBytes(runner.disk_free_bytes),
    ]),
  );
  if (runners.some((runner) => runner.last_error)) {
    console.log(`\n${BOLD}Errors${RESET}`);
    for (const runner of runners.filter((candidate) => candidate.last_error)) {
      console.log(`${RED}${runner.name}:${RESET} ${runner.last_error}`);
    }
  }
}

async function installRunner(args: string[]): Promise<void> {
  const serverRef = valueFlag(args, "server");
  const scopeUrl = valueFlag(args, "scope");
  const tokenEnv = valueFlag(args, "token-env") || "GITHUB_RUNNER_TOKEN";
  if (!serverRef || !scopeUrl) {
    throw new Error("Usage: ocd runners install --server=<name|id> --scope=https://github.com/OWNER [--name=X] [--token-env=GITHUB_RUNNER_TOKEN]");
  }
  const registrationToken = process.env[tokenEnv]?.trim();
  if (!registrationToken) throw new Error(`Set ${tokenEnv} to the fresh one-hour registration token from GitHub runner settings`);
  const server = await resolveServer(serverRef);
  const result = await post<{ op_id: number; workflow_runs_on: string[] }>("/api/runners", {
    server_id: server.id,
    scope_url: scopeUrl,
    registration_token: registrationToken,
    name: valueFlag(args, "name"),
  });
  const operation = await followOp(result.op_id);
  if (!operation.ok) throw new Error(operation.error || "Runner installation failed");
  console.log(`${GREEN}GitHub Actions runner installed on ${server.name}.${RESET}`);
  console.log(`Use this in build jobs: ${BOLD}runs-on: [${result.workflow_runs_on.join(", ")}]${RESET}`);
}

async function resolveRunner(ref: string): Promise<Runner> {
  const runners = await get<Runner[]>("/api/runners");
  const runner = /^\d+$/.test(ref)
    ? runners.find((candidate) => candidate.id === Number(ref))
    : runners.find((candidate) => candidate.name.toLowerCase() === ref.toLowerCase());
  if (!runner) throw new Error(`GitHub runner not found: ${ref}`);
  return runner;
}

async function removeRunner(args: string[]): Promise<void> {
  const ref = args.find((arg) => !arg.startsWith("-"));
  const tokenEnv = valueFlag(args, "token-env") || "GITHUB_RUNNER_REMOVE_TOKEN";
  if (!ref) throw new Error("Usage: ocd runners remove <name|id> [--token-env=GITHUB_RUNNER_REMOVE_TOKEN]");
  const removalToken = process.env[tokenEnv]?.trim();
  if (!removalToken) throw new Error(`Set ${tokenEnv} to a fresh removal token from GitHub runner settings`);
  const runner = await resolveRunner(ref);
  const result = await del<{ op_id: number }>(`/api/runners/${runner.id}`, { removal_token: removalToken });
  const operation = await followOp(result.op_id);
  if (!operation.ok) throw new Error(operation.error || "Runner removal failed");
  console.log(`${GREEN}Runner ${runner.name} deregistered; its server was retained.${RESET}`);
}

async function logs(args: string[]): Promise<void> {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("Usage: ocd runners logs <name|id> [--tail=N]");
  const tail = Number(valueFlag(args, "tail") || 200);
  const runner = await resolveRunner(ref);
  const result = await get<{ logs: string }>(`/api/runners/${runner.id}/logs?tail=${Math.min(1000, Math.max(1, tail))}`);
  process.stdout.write(result.logs.endsWith("\n") ? result.logs : `${result.logs}\n`);
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd runners <command>

${BOLD}Commands:${RESET}
  ls
      List runner health and disk headroom.

  install --server=X --scope=https://github.com/OWNER
      [--name=X] [--token-env=GITHUB_RUNNER_TOKEN]
      Install GitHub's official runner on an empty dedicated server. The
      short-lived token is encrypted only while the operation runs.

  remove <name|id> [--token-env=GITHUB_RUNNER_REMOVE_TOKEN]
      Deregister the runner and restore the server's prior capacity pool.

  logs <name|id> [--tail=N]
      Read the runner service journal (requires host-terminal permission).

${DIM}Build jobs use: runs-on: [self-hosted, ocd-builder]${RESET}`);
}

export async function runners(args: string[] = []): Promise<void> {
  const subcommand = args[0] || "ls";
  const rest = args.slice(1);
  switch (subcommand) {
    case "ls":
    case "list": return listRunners();
    case "install": return installRunner(rest);
    case "remove":
    case "delete": return removeRunner(rest);
    case "logs": return logs(rest);
    case "help":
    case "--help":
    case "-h": return usage();
    default:
      console.error(`${RED}Unknown runners command: ${subcommand}${RESET}`);
      usage();
      process.exit(1);
  }
}
