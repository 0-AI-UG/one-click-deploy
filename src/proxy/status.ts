// Local status endpoint + per-app last-activity tracking. The panel's
// reconciler scrapes GET /status over the host to gate readiness (nat applied,
// all listeners bound) and to feed scale-to-zero idle detection (lastActivity).
// Loopback only — nothing here is reachable off-host.

/** Default bind port for the status server (PROXY_LISTEN_PORT + 1). */
export const STATUS_PORT = 18791;

// appId → epoch ms of the most recently accepted front connection. Module-level
// so the hot path in tcp.ts is a single Map.set — no allocation, no I/O.
const lastActivity = new Map<number, number>();

/** Record an accepted front connection for `appId`. O(1) — called on the hot path. */
export function recordActivity(appId: number): void {
  lastActivity.set(appId, Date.now());
}

/** Snapshot of last-activity timestamps, keyed by appId as a string (JSON-shaped). */
export function getLastActivity(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [appId, ts] of lastActivity) out[String(appId)] = ts;
  return out;
}

export type StatusInputs = {
  natApplied(): boolean;
  listenersBound(): number;
  listenersTotal(): number;
};

/**
 * Serve GET /status on 127.0.0.1 with readiness JSON. `ok` means the proxy is
 * fully wired: the nft ruleset applied and every desired listener is bound.
 * Port 0 binds an ephemeral port (tests); the default is STATUS_PORT.
 */
export function startStatusServer(inputs: StatusInputs, port: number = STATUS_PORT): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "GET" || pathname !== "/status") return new Response("not found", { status: 404 });
      const natApplied = inputs.natApplied();
      const listenersBound = inputs.listenersBound();
      const listenersTotal = inputs.listenersTotal();
      return Response.json({
        ok: natApplied && listenersBound === listenersTotal,
        natApplied,
        listenersBound,
        listenersTotal,
        lastActivity: getLastActivity(),
      });
    },
  });
  return {
    // Bun types port as optional (unix-socket servers have none); a TCP bind
    // always yields one.
    port: server.port ?? port,
    stop() {
      server.stop(true);
    },
  };
}
