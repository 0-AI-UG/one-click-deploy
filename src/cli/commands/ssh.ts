import { get, resolveApp } from "../api.ts";
import { requireConfig } from "../config.ts";
import { BOLD, DIM, RESET } from "../format.ts";

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

  // Try matching by IP
  const byIp = servers.find((s) => s.ipv4 === nameOrId);
  if (byIp) return byIp;

  console.error(`Server not found: ${nameOrId}`);
  console.error(`Available servers: ${servers.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

export async function ssh(args: string[]): Promise<void> {
  if (!args[0]) {
    console.error(`${BOLD}Usage:${RESET} ocd ssh <app|server> [--server]

  ocd ssh <app>          Connect to an app container
  ocd ssh <server> --server  Connect to a server`);
    process.exit(1);
  }

  const isServer = args.includes("--server");
  const target = args.find((a) => !a.startsWith("--"))!;

  const config = requireConfig();
  const wsProto = config.panel_url.startsWith("https") ? "wss" : "ws";
  const host = config.panel_url.replace(/^https?:\/\//, "");

  let wsTarget: string;

  if (isServer) {
    const srv = await resolveServer(target);
    wsTarget = `server:${srv.id}`;
    console.log(`${DIM}Connecting to server ${srv.name} (${srv.ipv4})...${RESET}`);
  } else {
    const app = await resolveApp(target);
    const replicas = await get<Replica[]>(`/api/apps/${app.id}/replicas`);
    const running = replicas.filter((r) => r.status === "running");

    if (running.length === 0) {
      console.error(`No running replicas for ${app.name}`);
      process.exit(1);
    }

    const replica = running[0];
    wsTarget = `replica:${replica.id}`;
    console.log(`${DIM}Connecting to ${app.name} (${replica.container_name})...${RESET}`);
  }

  const url = `${wsProto}://${host}/api/terminal/ws?target=${wsTarget}&token=${encodeURIComponent(config.token)}`;

  const ws = new WebSocket(url);

  // Track if connection was established for clean exit messaging
  let connected = false;

  // Put stdin in raw mode for interactive terminal
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    connected = true;
    // Send initial terminal size
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      const buf = Buffer.from(data);
      // Skip heartbeat NUL bytes
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

  // Forward stdin to WebSocket
  process.stdin.on("data", (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Handle terminal resize
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
