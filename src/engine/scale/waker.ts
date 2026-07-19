// The hold-and-forward WAKER — the cold-start proxy that makes scale-to-zero
// transparent.
//
// An app that scaled to zero (status 'sleeping') has no replicas to serve, yet
// a connection to it must not fail. While it sleeps, the ingress renderer
// (traefik-render.ts) points the app's public Traefik router at this waker
// instead of a replica pool, and every server's ocd-proxy (src/proxy/) calls
// the wake endpoint here for internal connections. A request then,
// transparently:
//
//   1. RESOLVE  — figure out which app the request is for: the forwarded HTTP
//        `Host` header (public apps resolve by domain; `<app>.ocd.internal`
//        resolves by name), or the explicit appId of a proxy wake call.
//   2. WAKE     — call wakeApp(appId). Idempotent and COALESCED here: a burst
//        of connections shares one in-flight wake instead of stampeding.
//   3. HOLD     — poll the DB until the app is 'running' with real upstreams,
//        capped at ~120s. The first request is merely SLOW, never a 503 page.
//   4. FORWARD  — proxy to the real upstream (`<replica-private-ip>:<port>`),
//        replaying method/headers/body via fetch and streaming the response.
//        (Proxy wake calls get the upstream list back instead — the proxy
//        holds and pipes the raw connection itself.)
//
// TOPOLOGY: exactly ONE waker, in the panel process (so it reads the DB and
// calls wakeApp directly), reachable from every server's Traefik and ocd-proxy
// over the private network at `<panel-private-ip>:<waker-port>`. This mirrors
// how public ingress already centralizes on the panel; the panel is a
// cold-start choke point, but it is already the choke point for public
// ingress / ACME / the control plane, so no new failure domain is introduced.

import { timingSafeEqual } from "node:crypto";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { wakeApp } from "./wake.ts";
import { buildUpstreams } from "./traefik-render.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../scheduler.ts";
import { WAKER_HTTP_PORT } from "./traefik-constants.ts";

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

// Production is realDeps; tests swap it via __setWakerDeps to drive the
// hold-and-forward path without a DB or containers.
let wakerDeps: WakerDeps = realDeps;

/** Test seam: override (or, with null, restore) the default deps of the
 *  exported helpers. */
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
 * signal "give up, tell the client it's unavailable").
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

/**
 * Wake path for the fleet proxy's POST /api/internal/wake: the same
 * check-wake-hold composition as wakeAndResolveUpstreams, but surfaces an
 * immediate wake refusal (app busy, missing sleeping state, wake error) as its
 * error string instead of holding the full 120s.
 */
export async function wakeUpstreamsForProxy(
  appId: number,
  deps: WakerDeps = wakerDeps,
): Promise<{ ok: true; upstreams: string[] } | { ok: false; error: string }> {
  const app = deps.getApp(appId);
  if (!app) return { ok: false, error: "App not found" };
  if (app.status === "running") {
    const ups = deps.buildUpstreams(appId);
    if (ups.length > 0) return { ok: true, upstreams: ups };
  }
  const woke = await sharedWake(appId, deps);
  if (!woke.ok) return { ok: false, error: woke.error ?? "Wake failed" };
  const ups = await holdUntilReady(appId, deps);
  if (!ups || ups.length === 0) return { ok: false, error: "App did not wake in time" };
  return { ok: true, upstreams: ups };
}

/**
 * Full request handler for the fleet proxy's wake calls (frozen client
 * contract in src/proxy/wake.ts). Lives here — not in server/routes — because
 * it must be served on the waker's :8896 listener: that is the only panel
 * port published on the private IP (the API port binds 127.0.0.1 only), so
 * it's the only address other servers' proxies can reach. The /api/internal/
 * wake API route delegates to this same function.
 */
export async function handleProxyWakeRequest(request: Request): Promise<Response> {
  const presented = request.headers.get("x-ocd-wake-secret") ?? "";
  const expected = db.ensureProxyWakeSecret();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let appId: unknown;
  try {
    appId = ((await request.json()) as { appId?: unknown })?.appId;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof appId !== "number" || !Number.isInteger(appId)) {
    return Response.json({ ok: false, error: "appId must be a number" }, { status: 400 });
  }
  if (!db.getApp(appId)) {
    return Response.json({ ok: false, error: "App not found" }, { status: 404 });
  }

  const result = await wakeUpstreamsForProxy(appId);
  return Response.json(result, { status: result.ok ? 200 : 503 });
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
  // Fleet-proxy wake calls share this listener (see handleProxyWakeRequest).
  if (request.method === "POST" && new URL(request.url).pathname === "/api/internal/wake") {
    return handleProxyWakeRequest(request);
  }
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

// --- Lifecycle ----------------------------------------------------------------

let httpServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * Start the waker's HTTP listener. Idempotent. Wired into panel startup
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
}

export function stopWaker(): void {
  if (httpServer) {
    httpServer.stop(true);
    httpServer = null;
  }
}
