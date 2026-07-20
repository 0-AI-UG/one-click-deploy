// TCP data path: one Bun.listen per (app, tcp listener) on the app's VIP.
// Random backend pick with connect-retry over the remaining backends (this IS
// the health-aware LB), bidirectional piping with real backpressure, half-close
// propagation, and hold-and-forward for sleeping apps (buffer the opening
// client bytes, wake, connect, flush).

import type { Socket, SocketHandler } from "bun";
import type { ProxyApp, ProxyListener } from "./config.ts";
import { recordActivity } from "./status.ts";
import { sharedWake, type WakeFn } from "./wake.ts";

// While an app is waking there is nowhere to write: buffer at most this much
// from the client, then pause the socket until the upstream exists.
const WAKE_BUFFER_CAP = 1 << 20; // 1 MiB

export type TcpListenerHandle = {
  protocol: "tcp";
  port: number;
  update(app: ProxyApp): void;
  stop(): void;
};

type Conn = {
  client: Socket<Conn>;
  upstream: Socket<Conn> | null;
  /** client → upstream bytes (includes the opening bytes buffered pre-wake). */
  toUpstream: Buffer[];
  toUpstreamBytes: number;
  /** upstream → client bytes awaiting a writable client. */
  toClient: Buffer[];
  clientEnded: boolean;
  upstreamEnded: boolean;
  closed: boolean;
};

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function teardown(conn: Conn): void {
  if (conn.closed) return;
  conn.closed = true;
  try {
    conn.upstream?.terminate();
  } catch {
    /* gone */
  }
  try {
    conn.client.terminate();
  } catch {
    /* gone */
  }
}

/** Drain the client → upstream queue, honoring partial writes. Pauses the
 *  client under upstream backpressure, resumes it once the queue is empty, and
 *  propagates a pending client half-close after the final byte. */
function flushToUpstream(conn: Conn): void {
  const up = conn.upstream;
  if (!up || conn.closed) return;
  while (conn.toUpstream.length > 0) {
    const buf = conn.toUpstream[0];
    let n = 0;
    try {
      n = up.write(buf);
    } catch {
      teardown(conn);
      return;
    }
    if (n >= buf.length) {
      conn.toUpstream.shift();
      conn.toUpstreamBytes -= buf.length;
      continue;
    }
    if (n > 0) {
      conn.toUpstream[0] = buf.subarray(n);
      conn.toUpstreamBytes -= n;
    }
    conn.client.pause(); // upstream backpressure — resume on its drain
    return;
  }
  conn.toUpstreamBytes = 0;
  if (conn.clientEnded) {
    try {
      up.end();
    } catch {
      /* gone */
    }
  } else {
    conn.client.resume();
  }
}

/** Mirror of flushToUpstream for the upstream → client direction. */
function flushToClient(conn: Conn): void {
  if (conn.closed) return;
  while (conn.toClient.length > 0) {
    const buf = conn.toClient[0];
    let n = 0;
    try {
      n = conn.client.write(buf);
    } catch {
      teardown(conn);
      return;
    }
    if (n >= buf.length) {
      conn.toClient.shift();
      continue;
    }
    if (n > 0) conn.toClient[0] = buf.subarray(n);
    conn.upstream?.pause(); // client backpressure — resume on client drain
    return;
  }
  if (conn.upstreamEnded) {
    try {
      conn.client.end();
    } catch {
      /* gone */
    }
  } else {
    conn.upstream?.resume();
  }
}

const upstreamHandlers: SocketHandler<Conn> = {
  data(socket, chunk) {
    const conn = socket.data;
    conn.toClient.push(Buffer.from(chunk));
    flushToClient(conn);
  },
  drain(socket) {
    flushToUpstream(socket.data);
  },
  end(socket) {
    // Backend sent FIN: flush what it already sent, then half-close the client.
    const conn = socket.data;
    conn.upstreamEnded = true;
    if (conn.toClient.length === 0) {
      try {
        conn.client.end();
      } catch {
        /* gone */
      }
    }
  },
  close(socket) {
    teardown(socket.data);
  },
  error(socket) {
    teardown(socket.data);
  },
};

function dial(backend: string, conn: Conn): Promise<Socket<Conn>> {
  const idx = backend.lastIndexOf(":");
  return Bun.connect<Conn>({
    hostname: backend.slice(0, idx),
    port: Number(backend.slice(idx + 1)),
    data: conn,
    allowHalfOpen: true,
    socket: upstreamHandlers,
  });
}

/** Dial `backends` in random order until one accepts, then wire it up and
 *  flush the buffered opening bytes. Returns false only when every backend
 *  refused (a closed conn has nothing left to try — that reads as done). */
async function tryBackends(backends: string[], conn: Conn, app: ProxyApp): Promise<boolean> {
  for (const backend of shuffled(backends)) {
    if (conn.closed) return true;
    let upstream: Socket<Conn>;
    try {
      upstream = await dial(backend, conn);
    } catch (err) {
      console.error(`[proxy] dial ${backend} failed for app ${app.appId}: ${err}`);
      continue;
    }
    if (conn.closed) {
      try {
        upstream.terminate();
      } catch {
        /* gone */
      }
      return true;
    }
    conn.upstream = upstream;
    flushToUpstream(conn); // opening bytes buffered while connecting/waking
    return true;
  }
  return false;
}

async function connectUpstream(conn: Conn, ref: { app: ProxyApp }, wake: WakeFn): Promise<void> {
  const app = ref.app;
  // Empty pool: the app is asleep — wake it and connect to the returned pool.
  const woke = app.backends.length === 0;
  let backends = app.backends;
  if (woke) {
    try {
      backends = await sharedWake(app, wake);
    } catch (err) {
      console.error(`[proxy] wake failed for app ${app.appId} (${app.name}): ${err}`);
      teardown(conn);
      return;
    }
    if (conn.closed) return;
  }
  if (await tryBackends(backends, conn, app)) return;
  // Every configured backend refused: the pool is stale (the app slept or
  // moved since the last config render). Fall back to the wake path once —
  // never after a wake already produced this pool, or a dead app would loop.
  if (!woke) {
    try {
      backends = await sharedWake(app, wake);
    } catch (err) {
      console.error(`[proxy] wake after all-refused pool failed for app ${app.appId} (${app.name}): ${err}`);
      teardown(conn);
      return;
    }
    if (conn.closed) return;
    if (await tryBackends(backends, conn, app)) return;
  }
  console.error(`[proxy] no reachable backend for app ${app.appId} (${app.name})`);
  teardown(conn);
}

/**
 * Open one TCP listener on `app.vip:listener.port`.
 *
 * `enforceAuth` (default true) is the internal-path guard: a password-protected
 * app fail-closes on accept, because the internal VIP must not become an
 * unauthenticated bypass of the basicAuth Traefik enforces on the HTTP path.
 * The PUBLIC raw listener passes `enforceAuth:false` — raw exposure is
 * deliberately auth-free (Traefik served it unauthenticated too), and after
 * DNAT the original port is gone, so the two paths are told apart only by which
 * listen port accepted the connection.
 */
export function openTcpListener(
  app: ProxyApp,
  listener: ProxyListener,
  wake: WakeFn,
  opts: { enforceAuth?: boolean } = {},
): TcpListenerHandle {
  const enforceAuth = opts.enforceAuth ?? true;
  const ref = { app };
  const server = Bun.listen<Conn>({
    hostname: app.vip,
    port: listener.port,
    allowHalfOpen: true,
    socket: {
      open(socket) {
        const conn: Conn = {
          client: socket,
          upstream: null,
          toUpstream: [],
          toUpstreamBytes: 0,
          toClient: [],
          clientEnded: false,
          upstreamEnded: false,
          closed: false,
        };
        socket.data = conn;
        recordActivity(ref.app.appId);
        // L4 cannot check credentials — fail closed for password-protected
        // apps: no backend dial, no wake, just destroy the connection. Skipped
        // on the public raw listener (enforceAuth:false), which serves the
        // auth-free raw port exactly as Traefik did.
        if (enforceAuth && ref.app.authProtected) {
          teardown(conn);
          return;
        }
        // Snapshot at connect time: config reloads affect new connections only.
        void connectUpstream(conn, ref, wake);
      },
      data(socket, chunk) {
        const conn = socket.data;
        conn.toUpstream.push(Buffer.from(chunk));
        conn.toUpstreamBytes += chunk.length;
        if (conn.upstream) flushToUpstream(conn);
        else if (conn.toUpstreamBytes >= WAKE_BUFFER_CAP) socket.pause();
      },
      drain(socket) {
        flushToClient(socket.data);
      },
      end(socket) {
        // Client sent FIN: flush the remainder, then half-close the upstream.
        const conn = socket.data;
        conn.clientEnded = true;
        if (conn.upstream && conn.toUpstream.length === 0) {
          try {
            conn.upstream.end();
          } catch {
            /* gone */
          }
        }
      },
      close(socket) {
        teardown(socket.data);
      },
      error(socket) {
        teardown(socket.data);
      },
    },
  });
  return {
    protocol: "tcp",
    port: server.port,
    update(next) {
      ref.app = next;
    },
    stop() {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}
