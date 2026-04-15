import { get, post, resolveApp } from "../api.ts";
import { requireConfig } from "../config.ts";
import { BOLD, DIM, RED, RESET } from "../format.ts";

interface Server {
  id: number;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  apps?: { id: number; name: string }[];
}

interface Replica {
  id: number;
  app_id: number;
  server_id: number;
  container_name: string;
  status: string;
}

async function resolveServer(nameOrId: string): Promise<Server> {
  const servers = await get<Server[]>("/api/servers");

  const id = parseInt(nameOrId, 10);
  if (!isNaN(id)) {
    const srv = servers.find((s) => s.id === id);
    if (srv) return srv;
  }

  const lower = nameOrId.toLowerCase();
  const srv = servers.find((s) => s.name.toLowerCase() === lower);
  if (srv) return srv;

  const byIp = servers.find((s) => s.ipv4 === nameOrId);
  if (byIp) return byIp;

  console.error(`Server not found: ${nameOrId}`);
  console.error(`Available servers: ${servers.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

async function resolveTarget(args: string[]): Promise<{ wsTarget: string; label: string; isServer: boolean }> {
  const isServer = args.includes("--server");
  const target = args.find((a) => !a.startsWith("-"))!;

  if (isServer) {
    const srv = await resolveServer(target);
    return { wsTarget: `server:${srv.id}`, label: `${srv.name} (${srv.ipv4})`, isServer: true };
  }

  const app = await resolveApp(target);
  const replicas = await get<Replica[]>(`/api/apps/${app.id}/replicas`);
  const running = replicas.filter((r) => r.status === "running");

  if (running.length === 0) {
    console.error(`No running replicas for ${app.name}`);
    process.exit(1);
  }

  return { wsTarget: `replica:${running[0].id}`, label: `${app.name} (${running[0].container_name})`, isServer: false };
}

function buildWsUrl(wsTarget: string, token: string, panelUrl: string): string {
  const wsProto = panelUrl.startsWith("https") ? "wss" : "ws";
  const host = panelUrl.replace(/^https?:\/\//, "");
  return `${wsProto}://${host}/api/terminal/ws?target=${wsTarget}&token=${encodeURIComponent(token)}`;
}

// Run a command via the HTTP exec endpoint and print its output, then exit
// with the remote exit code. No PTY, no shell prompt noise.
async function execCommand(wsTarget: string, command: string): Promise<void> {
  try {
    const res = await post<{ stdout: string; stderr: string; exitCode: number }>(
      "/api/terminal/exec",
      { target: wsTarget, command },
    );
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}${msg}${RESET}`);
    process.exit(1);
  }
}

// Interactive terminal session.
function interactive(url: string, label: string): void {
  console.log(`${DIM}Connecting to ${label}...${RESET}`);

  const ws = new WebSocket(url);
  let connected = false;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    connected = true;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      const buf = Buffer.from(data);
      if (buf.length === 1 && buf[0] === 0) return;
      process.stdout.write(buf);
    } else if (typeof data === "string") {
      process.stdout.write(data);
    }
  });

  ws.addEventListener("close", (event) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    if (event.code !== 4000 && !connected) {
      console.error("Connection failed. Check your login session.");
    }
    process.exit(0);
  });

  ws.addEventListener("error", () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    console.error("WebSocket connection error");
    process.exit(1);
  });

  process.stdin.on("data", (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  process.stdout.on("resize", () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      }));
    }
  });
}

export async function ssh(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    console.error(`${BOLD}Usage:${RESET} ocd ssh <app|server> [command] [options]

  ocd ssh <app> <command>       Run a command and print output
  ocd ssh <app> -i              Interactive terminal session
  ocd ssh <server> --server     Connect to a server (interactive)

${BOLD}Options:${RESET}
  -i, --interactive             Open an interactive shell
  --server                      Target a server instead of an app`);
    process.exit(1);
  }

  const isInteractive = args.includes("-i") || args.includes("--interactive");
  const isServer = args.includes("--server");

  // Collect the command: everything that isn't a flag or the target
  const target = args.find((a) => !a.startsWith("-"))!;
  const command = args
    .slice(args.indexOf(target) + 1)
    .filter((a) => a !== "-i" && a !== "--interactive" && a !== "--server")
    .join(" ");

  if (!isInteractive && !command) {
    console.error(`${RED}Provide a command or use -i for interactive mode${RESET}`);
    console.error(`Run "ocd ssh --help" for usage.`);
    process.exit(1);
  }

  const { wsTarget, label } = await resolveTarget(args);

  if (isInteractive) {
    const config = requireConfig();
    const url = buildWsUrl(wsTarget, config.token, config.panel_url);
    interactive(url, label);
  } else {
    await execCommand(wsTarget, command);
  }
}
