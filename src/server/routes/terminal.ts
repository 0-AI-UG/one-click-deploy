import { jwtVerify } from "jose";
import * as db from "../../bun/db.ts";
import { spawnSshPty, type PtySession } from "../../bun/remote/index.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [terminal:${context}]`, ...args);
}

const rawSecret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "one-click-deploy-dev-secret",
);
const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

const MAX_SESSIONS_PER_USER = 3;
const sessionsByUser = new Map<string, number>();

export type TerminalWsData = {
  userId: string;
  target: { kind: "server" | "replica" | "service-instance"; id: number };
  pty: PtySession | null;
};

async function authFromQuery(req: Request): Promise<{ userId: string } | null> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const p = payload as Record<string, unknown>;
    if (p.purpose) return null;
    return { userId: p.userId as string };
  } catch {
    return null;
  }
}

function checkPermission(userId: string): boolean {
  const user = db.getUserById(userId);
  if (!user) return false;
  if (user.is_admin) return true;
  return db.hasPermission(userId, "terminal.access");
}

/**
 * Parse `/api/terminal/ws?target=server:123` or `replica:45`.
 */
function parseTarget(req: Request): { kind: "server" | "replica" | "service-instance"; id: number } | null {
  const url = new URL(req.url);
  const t = url.searchParams.get("target") || "";
  const m = t.match(/^(server|replica|service-instance):(\d+)$/);
  if (!m) return null;
  return { kind: m[1] as "server" | "replica" | "service-instance", id: parseInt(m[2], 10) };
}

/**
 * Called from the server fetch fallback. Returns:
 *   - Response on rejection (401/403/404/400)
 *   - null if the upgrade succeeded (caller should return undefined)
 *   - null if the path is not the terminal path (caller continues routing)
 */
export async function tryTerminalUpgrade(req: Request, server: Bun.Server<TerminalWsData>): Promise<Response | null | "not-matched"> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/terminal/ws") return "not-matched";

  const auth = await authFromQuery(req);
  if (!auth) return new Response("unauthorized", { status: 401 });

  if (!checkPermission(auth.userId)) {
    return new Response("forbidden", { status: 403 });
  }

  const target = parseTarget(req);
  if (!target) return new Response("bad target", { status: 400 });

  const active = sessionsByUser.get(auth.userId) ?? 0;
  if (active >= MAX_SESSIONS_PER_USER) {
    return new Response("too many terminal sessions", { status: 429 });
  }

  const data: TerminalWsData = { userId: auth.userId, target, pty: null };
  const ok = server.upgrade(req, { data });
  if (!ok) return new Response("upgrade failed", { status: 500 });
  return null;
}

export const terminalWsHandlers = {
  open(ws: Bun.ServerWebSocket<TerminalWsData>) {
    const data = ws.data as TerminalWsData;
    sessionsByUser.set(data.userId, (sessionsByUser.get(data.userId) ?? 0) + 1);

    let ip: string | undefined;
    let hostKey: string | undefined;
    let remoteCommand: string | undefined;

    if (data.target.kind === "server") {
      const srv = db.getServer(data.target.id);
      if (!srv) {
        ws.send("server not found\r\n");
        ws.close();
        return;
      }
      ip = srv.ipv4;
      hostKey = srv.ssh_host_key || undefined;
      log("open", `user=${data.userId} server=${srv.id} ip=${ip}`);
    } else if (data.target.kind === "replica") {
      const replica = db.getReplica(data.target.id);
      if (!replica) {
        ws.send("replica not found\r\n");
        ws.close();
        return;
      }
      const srv = db.getServer(replica.server_id);
      if (!srv) {
        ws.send("replica's server not found\r\n");
        ws.close();
        return;
      }
      ip = srv.ipv4;
      hostKey = srv.ssh_host_key || undefined;
      // docker exec as deploy user into the specific container
      remoteCommand = `su - deploy -c 'docker exec -it ${replica.container_name} sh -lc "exec \\$(command -v bash >/dev/null && echo bash || echo sh)"'`;
      log("open", `user=${data.userId} replica=${replica.id} container=${replica.container_name} ip=${ip}`);
    } else {
      // service-instance
      const instance = db.getServiceInstance(data.target.id);
      if (!instance) {
        ws.send("service instance not found\r\n");
        ws.close();
        return;
      }
      const srv = db.getServer(instance.server_id);
      if (!srv) {
        ws.send("service instance's server not found\r\n");
        ws.close();
        return;
      }
      ip = srv.ipv4;
      hostKey = srv.ssh_host_key || undefined;
      remoteCommand = `su - deploy -c 'docker exec -it ${instance.container_name} sh -lc "exec \\$(command -v bash >/dev/null && echo bash || echo sh)"'`;
      log("open", `user=${data.userId} service-instance=${instance.id} container=${instance.container_name} ip=${ip}`);
    }

    const pty = spawnSshPty({
      ip: ip!,
      hostKey,
      remoteCommand,
      onStdout: (chunk) => {
        try { ws.send(chunk); } catch { /* ws may be closed */ }
      },
      onExit: (code) => {
        try { ws.send(`\r\n[session ended, exit ${code}]\r\n`); } catch { /* ws may be closed */ }
        try { ws.close(); } catch { /* ws may already be closed */ }
      },
    });
    data.pty = pty;
  },

  message(ws: Bun.ServerWebSocket<TerminalWsData>, message: string | Uint8Array) {
    const data = ws.data as TerminalWsData;
    if (!data.pty) return;
    if (typeof message === "string") {
      // Control frame (JSON) — currently only resize is supported, and we
      // can't forward it without a local PTY, so we just ignore.
      if (message.startsWith("{")) return;
      data.pty.write(message);
    } else {
      data.pty.write(message);
    }
  },

  close(ws: Bun.ServerWebSocket<TerminalWsData>) {
    const data = ws.data as TerminalWsData;
    if (data.pty) {
      try { data.pty.kill(); } catch { /* process may already be dead */ }
    }
    const n = (sessionsByUser.get(data.userId) ?? 1) - 1;
    if (n <= 0) sessionsByUser.delete(data.userId);
    else sessionsByUser.set(data.userId, n);
    log("close", `user=${data.userId}`);
  },
};
