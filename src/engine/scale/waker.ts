// The hold-and-forward WAKER — the cold-start proxy that makes scale-to-zero
// transparent on every path.
//
// An app that scaled to zero (status 'sleeping') has no replicas to serve, yet
// a connection to it must not fail. While it sleeps, the ingress renderer
// (traefik-render.ts) points ALL of the app's Traefik routers at this waker
// instead of a replica pool. A connection then, transparently:
//
//   1. RESOLVE  — figure out which app the connection is for.
//        · HTTP: the forwarded `Host` header. Public apps resolve by domain;
//          internal callers hit `<app>.ocd.internal:<port>`, so `<app>` under
//          the `.ocd.internal` suffix resolves by app name.
//        · Raw TCP/UDP: the waker LISTENS ON A DISTINCT PORT PER APP (derived
//          from the app's internal port), so the port a connection arrived on
//          identifies the app — raw sockets carry no Host. reconcileWakerPorts
//          opens/closes those per-app listeners as apps sleep and wake.
//   2. WAKE     — call wakeApp(appId). Idempotent and COALESCED here: a burst
//        of connections shares one in-flight wake instead of stampeding.
//   3. HOLD     — poll the DB until the app is 'running' with real upstreams,
//        capped at ~120s. The first request is merely SLOW, never a 503 page.
//   4. FORWARD  — proxy to the real upstream (`<replica-private-ip>:<port>`).
//        HTTP replays method/headers/body via fetch and streams the response;
//        raw TCP buffers the client's opening bytes, dials the upstream, then
//        pipes bidirectionally (protocol-agnostic — Postgres, Redis, …).
//
// TOPOLOGY: exactly ONE waker, in the panel process (so it reads the DB and
// calls wakeApp directly), reachable from every server's Traefik over the
// private network at `<panel-private-ip>:<waker-port>`. This mirrors how public
// ingress already centralizes on the panel; the panel is a cold-start choke
// point, but it is already the choke point for public ingress / ACME / the
// control plane, so no new failure domain is introduced. See the "waker" header
// in traefik-constants.ts for the port constants and traefik-render.ts for the
// router wiring.
//
// This replaced the browser-only 503 "wake page", which woke nothing for
// internal callers, raw TCP/UDP ports, or any non-browser HTTP client.

import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { wakeApp } from "./wake.ts";
import { buildUpstreams } from "./traefik-render.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../scheduler.ts";
import {
  wakerTcpPort,
  wakerUdpPort,
  WAKER_HTTP_PORT,
} from "./traefik-constants.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [waker]`, ...args);
}

// Injectable seam so the resolution / wake-coalescing / hold logic can be unit
// tested without a live DB or real containers. Production wiring is realDeps.
export type WakerDeps = {
  getApp: (id: number) => AppRow | null;
  getAppByName: (name: string) => AppRow | null;
  getAppByDomain: (domain: string) => AppRow | null;
  wake: (appId: number) => Promise<{ ok: boolean; error?: string }>;
  buildUpstreams: (appId: number) => string[];
};

// Connection-driven wake, serialized against the engine. The waker fires on
// inbound traffic at any instant, so without the app lock it can `docker run` a
// new replica and flip the app back to 'running' while a destroy/pause/redeploy
// op holds the app — resurrecting a half-torn-down app. Take the same app lock
// the engine uses; if an op owns it, refuse the wake (the caller retries, and an
// app mid-operation shouldn't be woken anyway). The lock lives here, not inside
// wakeApp, because engine ops (ops/wake.ts, ops/redeploy.ts) call wakeApp while
// already holding the app lock and would otherwise deadlock against themselves.
async function wakeWithLock(appId: number): Promise<{ ok: boolean; error?: string }> {
  const lock = tryAcquire([`app:${appId}`], NON_OP_HOLDER, "wake");
  if (!lock.ok) {
    log("wake", `app ${appId}: held by ${lock.heldBy.kind}#${lock.heldBy.opId} — deferring wake`);
    return { ok: false, error: `App is busy with another operation (${lock.heldBy.kind})` };
  }
  try {
    return await wakeApp(appId);
  } finally {
    release([`app:${appId}`]);
  }
}

const realDeps: WakerDeps = {
  getApp: (id) => db.getApp(id),
  getAppByName: (name) => db.getAppByName(name),
  getAppByDomain: (domain) => db.getAppByDomain(domain),
  wake: (appId) => wakeWithLock(appId),
  buildUpstreams: (appId) => buildUpstreams(appId),
};

// The deps the socket handlers (which can't take a param) resolve against.
// Production is realDeps; tests swap it via __setWakerDeps to drive the
// hold-and-forward path with in-memory sockets and no DB/containers.
let wakerDeps: WakerDeps = realDeps;

/** Test seam: override (or, with null, restore) the deps used by the socket
 *  handlers and the default of the exported helpers. */
export function __setWakerDeps(deps: WakerDeps | null): void {
  wakerDeps = deps ?? realDeps;
}

const INTERNAL_SUFFIX = ".ocd.internal";

/**
 * Resolve the app a connection targets from its HTTP `Host` header. Internal
 * callers use `<app>.ocd.internal[:port]` (resolve by name); public callers use
 * the app's domain (resolve by domain). Port and case are ignored. Returns null
 * for an unknown/blank host.
 */
export function resolveAppByHost(host: string | null | undefined, deps: WakerDeps = wakerDeps): AppRow | null {
  const h = (host || "").trim().toLowerCase().split(":")[0];
  if (!h) return null;
  if (h.endsWith(INTERNAL_SUFFIX)) {
    const name = h.slice(0, -INTERNAL_SUFFIX.length);
    return name ? deps.getAppByName(name) : null;
  }
  return deps.getAppByDomain(h);
}

// One shared in-flight wake per app: concurrent connections during a cold start
// all await the same wakeApp promise instead of each firing their own. wakeApp
// is itself idempotent (no-ops once the app leaves 'sleeping'); this additionally
// collapses the redundant work of the very first concurrent burst.
const wakeInFlight = new Map<number, Promise<{ ok: boolean; error?: string }>>();

export function sharedWake(appId: number, deps: WakerDeps = wakerDeps): Promise<{ ok: boolean; error?: string }> {
  let p = wakeInFlight.get(appId);
  if (!p) {
    p = Promise.resolve()
      .then(() => deps.wake(appId))
      .finally(() => wakeInFlight.delete(appId));
    wakeInFlight.set(appId, p);
  }
  return p;
}

const HOLD_TIMEOUT_MS = 120_000;
const HOLD_POLL_MS = 250;

/**
 * Poll until the app is servable — status 'running' with a non-empty upstream
 * pool — and return its upstreams. Returns null if it never gets there within
 * the cap, if the app was deleted, or if the wake errored (status 'error').
 */
export async function holdUntilReady(
  appId: number,
  deps: WakerDeps = wakerDeps,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string[] | null> {
  const timeout = opts.timeoutMs ?? HOLD_TIMEOUT_MS;
  const poll = opts.pollMs ?? HOLD_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + timeout;
  for (;;) {
    const app = deps.getApp(appId);
    if (!app || app.status === "error") return null;
    if (app.status === "running") {
      const ups = deps.buildUpstreams(appId);
      if (ups.length > 0) return ups;
    }
    if (Date.now() >= deadline) return null;
    await sleep(poll);
  }
}

/**
 * Resolve → wake → hold, returning the upstream pool to forward to (or null to
 * signal "give up, tell the client it's unavailable"). Shared by the HTTP and
 * raw-TCP/UDP entry points.
 */
export async function wakeAndResolveUpstreams(app: AppRow, deps: WakerDeps = wakerDeps): Promise<string[] | null> {
  // Race: the app may have woken between the render and this connection (the
  // config still points here for a tick). If it is already running with a pool,
  // forward straight through without a wake.
  const fresh = deps.getApp(app.id);
  if (fresh && fresh.status === "running") {
    const ups = deps.buildUpstreams(app.id);
    if (ups.length > 0) return ups;
  }
  await sharedWake(app.id, deps);
  return holdUntilReady(app.id, deps);
}

// --- HTTP path ----------------------------------------------------------------

function http503(message: string): Response {
  return new Response(JSON.stringify({ error: "app_unavailable", message }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "retry-after": "5",
      "cache-control": "no-store",
    },
  });
}

// Hop-by-hop headers must not be forwarded to the upstream (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Handle one HTTP request that Traefik routed to the waker (i.e. for a sleeping
 * app). Resolve the app by Host, wake+hold, then replay the request to a real
 * upstream and stream the response back. A real 503 (short JSON) on
 * unknown-host / timeout / unreachable-upstream — never the old HTML page; the
 * `retry` middleware stays as a backstop.
 */
export async function handleWakerHttp(request: Request, deps: WakerDeps = wakerDeps): Promise<Response> {
  // Traefik forwards the original Host header; fall back to the URL authority
  // (Bun derives request.url from the Host, so they agree) for robustness.
  const host = request.headers.get("host") || new URL(request.url).host;
  const app = resolveAppByHost(host, deps);
  if (!app) return http503("Unknown host — no matching app");

  const upstreams = await wakeAndResolveUpstreams(app, deps);
  if (!upstreams || upstreams.length === 0) return http503("App did not wake in time");

  const url = new URL(request.url);
  const target = `http://${upstreams[0]}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);

  // Buffer the body and replay it (preserving method/headers) rather than
  // streaming — dodges duplex-stream pitfalls and matches the "replay the
  // initial bytes" model. Cold-start requests are typically small.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  try {
    return await fetch(target, { method: request.method, headers, body, redirect: "manual" });
  } catch (err) {
    log(`upstream ${target} unreachable: ${err}`);
    return http503("Upstream unreachable");
  }
}

// --- Raw TCP path -------------------------------------------------------------

type TcpConn = {
  appId: number;
  client: import("bun").Socket<TcpConn>;
  upstream: import("bun").Socket<TcpConn> | null;
  /** Bytes waiting to be written to the CLIENT (upstream → client). */
  toClient: Buffer[];
  /** Bytes waiting to be written to the UPSTREAM (client → upstream), including
   *  the opening bytes buffered before the upstream socket connected. */
  toUpstream: Buffer[];
  closed: boolean;
};

/** Drain a write queue into a socket, honoring partial writes (Bun's write is
 *  non-blocking and may accept fewer bytes; the rest waits for `drain`). */
function flushQueue(sock: import("bun").Socket<unknown>, queue: Buffer[]): void {
  while (queue.length > 0) {
    const buf = queue[0];
    let n = 0;
    try {
      n = sock.write(buf);
    } catch {
      queue.length = 0;
      return;
    }
    if (n >= buf.length) {
      queue.shift();
      continue;
    }
    if (n > 0) queue[0] = buf.subarray(n);
    return; // backpressure — resume on drain
  }
}

function endBoth(conn: TcpConn): void {
  conn.closed = true;
  try {
    conn.upstream?.end();
  } catch {
    /* already gone */
  }
  try {
    conn.client.end();
  } catch {
    /* already gone */
  }
}

/** Client-side (listener) socket handlers. Bound per listener via a getAppId
 *  closure so a rebuilt port→app mapping is picked up without re-listening. */
export function tcpClientHandlers(getAppId: () => number): import("bun").SocketHandler<TcpConn> {
  return {
    open(socket) {
      const conn: TcpConn = {
        appId: getAppId(),
        client: socket,
        upstream: null,
        toClient: [],
        toUpstream: [],
        closed: false,
      };
      socket.data = conn;
      void startTcpForward(conn);
    },
    data(socket, chunk) {
      const conn = socket.data;
      conn.toUpstream.push(Buffer.from(chunk));
      if (conn.upstream) flushQueue(conn.upstream, conn.toUpstream);
    },
    drain(socket) {
      // Client is writable again — resume upstream → client.
      flushQueue(socket, socket.data.toClient);
    },
    close(socket) {
      socket.data.closed = true;
      try {
        socket.data.upstream?.end();
      } catch {
        /* gone */
      }
    },
    error(socket) {
      socket.data.closed = true;
      try {
        socket.data.upstream?.end();
      } catch {
        /* gone */
      }
    },
  };
}

async function startTcpForward(conn: TcpConn): Promise<void> {
  const app = wakerDeps.getApp(conn.appId);
  if (!app) {
    endBoth(conn);
    return;
  }
  const upstreams = await wakeAndResolveUpstreams(app);
  if (!upstreams || upstreams.length === 0 || conn.closed) {
    endBoth(conn);
    return;
  }
  const [host, portStr] = upstreams[0].split(":");
  try {
    const upstream = await Bun.connect<TcpConn>({
      hostname: host,
      port: Number(portStr),
      data: conn,
      socket: {
        data(sock, chunk) {
          sock.data.toClient.push(Buffer.from(chunk));
          flushQueue(sock.data.client, sock.data.toClient);
        },
        drain(sock) {
          // Upstream writable again — resume client → upstream.
          flushQueue(sock, sock.data.toUpstream);
        },
        close(sock) {
          try {
            sock.data.client.end();
          } catch {
            /* gone */
          }
        },
        error(sock) {
          try {
            sock.data.client.end();
          } catch {
            /* gone */
          }
        },
      },
    });
    if (conn.closed) {
      try {
        upstream.end();
      } catch {
        /* gone */
      }
      return;
    }
    conn.upstream = upstream;
    // Flush the opening bytes the client sent while we were waking + holding.
    flushQueue(upstream, conn.toUpstream);
  } catch (err) {
    log(`tcp dial ${upstreams[0]} failed for app ${conn.appId}: ${err}`);
    endBoth(conn);
  }
}

// --- Raw UDP path -------------------------------------------------------------
//
// UDP is connectionless, so "hold" is per source peer: on the first datagram
// from a peer we wake+hold and open a connected upstream socket for it, buffering
// that peer's datagrams until it is ready. Replies from the upstream are sent
// back to the peer's address. Idle peers are swept so the maps don't grow
// unbounded. Best-effort by nature (UDP is lossy) — a datagram or two during the
// cold start may be dropped, which UDP clients already tolerate.

type UdpPeer = {
  buffer: Buffer[];
  upstream: import("bun").udp.ConnectedSocket<"buffer"> | null;
  lastActive: number;
  connecting: boolean;
};

type UdpListenerEntry = {
  socket: import("bun").udp.Socket<"buffer">;
  ref: { appId: number };
  peers: Map<string, UdpPeer>;
};

const UDP_PEER_IDLE_MS = 60_000;

async function setupUdpPeer(
  entry: UdpListenerEntry,
  peer: UdpPeer,
  peerKey: string,
  addr: string,
  port: number,
): Promise<void> {
  const appId = entry.ref.appId;
  const app = wakerDeps.getApp(appId);
  if (!app) {
    entry.peers.delete(peerKey);
    return;
  }
  const upstreams = await wakeAndResolveUpstreams(app);
  if (!upstreams || upstreams.length === 0) {
    entry.peers.delete(peerKey);
    return;
  }
  const [host, portStr] = upstreams[0].split(":");
  try {
    peer.upstream = await Bun.udpSocket({
      connect: { hostname: host, port: Number(portStr) },
      socket: {
        data(_sock, buf) {
          try {
            entry.socket.send(buf, port, addr);
          } catch {
            /* peer gone */
          }
        },
      },
    });
    for (const d of peer.buffer) peer.upstream.send(d);
    peer.buffer = [];
  } catch (err) {
    log(`udp dial ${upstreams[0]} failed for app ${appId}: ${err}`);
    entry.peers.delete(peerKey);
  }
}

function udpHandlers(entry: () => UdpListenerEntry): import("bun").udp.SocketHandler<"buffer"> {
  return {
    data(_socket, data, port, addr) {
      const e = entry();
      const key = `${addr}:${port}`;
      let peer = e.peers.get(key);
      if (!peer) {
        peer = { buffer: [], upstream: null, lastActive: Date.now(), connecting: true };
        e.peers.set(key, peer);
        void setupUdpPeer(e, peer, key, addr, port).finally(() => {
          if (peer) peer.connecting = false;
        });
      }
      peer.lastActive = Date.now();
      if (peer.upstream) peer.upstream.send(Buffer.from(data));
      else peer.buffer.push(Buffer.from(data));
    },
  };
}

// --- Lifecycle / port reconciliation -----------------------------------------

let httpServer: ReturnType<typeof Bun.serve> | null = null;
const tcpListeners = new Map<number, { listener: import("bun").TCPSocketListener<TcpConn>; ref: { appId: number } }>();
const udpListeners = new Map<number, UdpListenerEntry>();
let udpSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Recompute which per-app raw TCP/UDP listeners must be open for the currently
 * sleeping apps and converge to it — open the missing, close the obsolete. The
 * shared HTTP listener needs no per-app ports (it resolves by Host), so it is
 * untouched here. Called on startup, from the reconciler tick, and right after
 * an app is put to sleep so a raw connection can wake it promptly.
 */
export function reconcileWakerPorts(): void {
  const desiredTcp = new Map<number, number>(); // waker port -> appId
  const desiredUdp = new Map<number, number>();
  for (const app of db.getApps()) {
    if (app.status !== "sleeping" && app.status !== "waking") continue;
    // Internal raw-TCP router (internal_protocol='tcp' and no basic auth — auth
    // forces HTTP routing, matching the ingress renderer's `httpRouted`).
    const httpRouted = app.internal_protocol === "http" || !!app.auth_password_hash;
    if (!httpRouted) desiredTcp.set(wakerTcpPort(app.internal_port), app.id);
    // Public raw exposure shares the same per-app waker port (both dial the
    // same upstream once awake).
    if (app.public_port != null) {
      if (app.public_protocol === "udp") desiredUdp.set(wakerUdpPort(app.internal_port), app.id);
      else desiredTcp.set(wakerTcpPort(app.internal_port), app.id);
    }
  }

  // TCP: open missing, refresh appId, close obsolete.
  for (const [port, appId] of desiredTcp) {
    const existing = tcpListeners.get(port);
    if (existing) {
      existing.ref.appId = appId;
      continue;
    }
    const ref = { appId };
    try {
      const listener = Bun.listen<TcpConn>({
        hostname: "0.0.0.0",
        port,
        socket: tcpClientHandlers(() => ref.appId),
      });
      tcpListeners.set(port, { listener, ref });
      log(`opened TCP waker :${port} → app ${appId}`);
    } catch (err) {
      log(`failed to open TCP waker :${port}: ${err}`);
    }
  }
  for (const [port, entry] of [...tcpListeners]) {
    if (desiredTcp.has(port)) continue;
    try {
      entry.listener.stop();
    } catch {
      /* already stopped */
    }
    tcpListeners.delete(port);
    log(`closed TCP waker :${port}`);
  }

  // UDP: same convergence.
  for (const [port, appId] of desiredUdp) {
    const existing = udpListeners.get(port);
    if (existing) {
      existing.ref.appId = appId;
      continue;
    }
    void openUdpListener(port, appId);
  }
  for (const [port, entry] of [...udpListeners]) {
    if (desiredUdp.has(port)) continue;
    try {
      entry.socket.close();
    } catch {
      /* already closed */
    }
    for (const peer of entry.peers.values()) peer.upstream?.close();
    udpListeners.delete(port);
    log(`closed UDP waker :${port}`);
  }
}

async function openUdpListener(port: number, appId: number): Promise<void> {
  if (udpListeners.has(port)) return;
  const ref = { appId };
  const entry: UdpListenerEntry = { socket: null as never, ref, peers: new Map() };
  try {
    entry.socket = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port,
      socket: udpHandlers(() => entry),
    });
    udpListeners.set(port, entry);
    log(`opened UDP waker :${port} → app ${appId}`);
  } catch (err) {
    log(`failed to open UDP waker :${port}: ${err}`);
  }
}

function sweepUdpPeers(): void {
  const now = Date.now();
  for (const entry of udpListeners.values()) {
    for (const [key, peer] of [...entry.peers]) {
      if (peer.connecting || now - peer.lastActive < UDP_PEER_IDLE_MS) continue;
      peer.upstream?.close();
      entry.peers.delete(key);
    }
  }
}

/**
 * Start the waker: the shared HTTP listener plus the per-app raw listeners for
 * whatever is currently asleep. Idempotent. Wired into panel startup
 * (startEngineInProcess) since the engine runs in the panel process.
 */
export function startWaker(): void {
  if (httpServer) return;
  httpServer = Bun.serve({
    port: WAKER_HTTP_PORT,
    hostname: "0.0.0.0",
    // A cold start holds the request up to ~120s with no bytes flowing; disable
    // the idle timeout so Bun doesn't drop the connection mid-hold.
    idleTimeout: 0,
    fetch: (request) => handleWakerHttp(request),
  });
  log(`HTTP listening on :${WAKER_HTTP_PORT}`);
  udpSweepTimer = setInterval(sweepUdpPeers, UDP_PEER_IDLE_MS);
  reconcileWakerPorts();
}

export function stopWaker(): void {
  if (httpServer) {
    httpServer.stop(true);
    httpServer = null;
  }
  if (udpSweepTimer) {
    clearInterval(udpSweepTimer);
    udpSweepTimer = null;
  }
  for (const { listener } of tcpListeners.values()) {
    try {
      listener.stop();
    } catch {
      /* already stopped */
    }
  }
  tcpListeners.clear();
  for (const entry of udpListeners.values()) {
    for (const peer of entry.peers.values()) peer.upstream?.close();
    try {
      entry.socket.close();
    } catch {
      /* already closed */
    }
  }
  udpListeners.clear();
}
