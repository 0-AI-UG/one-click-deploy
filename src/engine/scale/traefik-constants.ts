// Shared Traefik constants and pure name/port helpers. Both halves of the
// ingress stack depend on these: traefik-provision.ts (bash static-config /
// systemd / install generators) and traefik-render.ts (desired-state + dynamic
// YAML render). Kept dependency-light so neither half has to import the other.

/** Pinned Traefik release installed on every server. v3.5+ is required for
 *  TCP server health checks (`tcp.services.*.loadBalancer.healthCheck`),
 *  which replace Caddy's passive checks for health_check=0 apps. */
export const TRAEFIK_VERSION = "3.7.7";

/** Prometheus metrics entrypoint. The reconciler scrapes it per tick over SSH
 *  (curl from localhost) to drive request-rate-based scale-to-zero. */
export const TRAEFIK_METRICS_PORT = 8899;

/** Fixed username for password-protected apps. The old auth-proxy sidecar was
 *  password-only; basicAuth needs a user, so every htpasswd entry uses this
 *  one (UI copy tells visitors to sign in as "admin"). */
export const BASIC_AUTH_USER = "admin";

// --- Hold-and-forward waker ---------------------------------------------------
//
// Sleeping apps (scale-to-zero) can't serve, but a connection to one must not
// fail — it must transparently wake the app, wait, and be forwarded. That job
// belongs to the WAKER, an in-process HTTP proxy that runs on the PANEL
// (src/engine/scale/waker.ts). While an app sleeps, its public Traefik router
// points at the waker instead of a (non-existent) replica pool; when it wakes,
// the reconciler re-renders it back to the real replicas. Internal callers
// never reach the waker's proxy path anymore — the per-host VIP proxy
// (src/proxy/) holds the connection itself and calls the waker's
// /api/internal/wake on :8896.
//
// Topology: ONE waker on the panel (like public ingress, which already
// centralizes there). Every server's Traefik and ocd-proxy reach it over the
// private network at `<panel-private-ip>:<waker-port>`. Tradeoff: the panel is
// a wake choke point / SPOF for cold starts — but it is already the choke
// point for all public ingress, ACME and the control plane, so this adds no
// new failure domain.

/** The waker's single HTTP listener. Sleeping apps' public routers forward
 *  here (the waker resolves the app from the forwarded `Host` header, wakes
 *  it, holds the request, then proxies to the real upstream), and every
 *  server's ocd-proxy POSTs /api/internal/wake here for internal traffic. */
export const WAKER_HTTP_PORT = 8896;

/**
 * The `docker run -p` publish flags the PANEL container must carry so the
 * in-process waker's HTTP listener is reachable from every server's Traefik over
 * the private network (Traefik dials `<panel-private-ip>:${WAKER_HTTP_PORT}`).
 * Without this the waker binds fine INSIDE the container but nothing is mapped to
 * the host, so every sleeping-app HTTP router 502s and nothing ever wakes.
 *
 * Bound to the panel's private IPv4 (NOT 0.0.0.0): the waker forwards straight
 * to internal upstreams and bypasses Traefik's auth/allowlist/rate-limit
 * middleware, so it must never be exposed on the public interface.
 *
 * SCOPE: HTTP only. The single HTTP listener resolves every app by Host header,
 * so one published port covers all HTTP apps. Raw public TCP/UDP scale-to-zero
 * is unsupported: a sleeping app renders no pub/pubu route until it is woken
 * by other traffic.
 *
 * Returns [] when no private IP is known (nothing to bind to); the next
 * reconciler-driven redeploy backfills it once the network is attached.
 */
export function wakerPublishFlags(privateIpv4: string): string[] {
  if (!privateIpv4) return [];
  return [`-p ${privateIpv4}:${WAKER_HTTP_PORT}:${WAKER_HTTP_PORT}`];
}

/** Shared Traefik HTTP service name every sleeping app's HTTP router targets —
 *  a single load balancer pointing at the panel waker's HTTP listener. */
export const WAKER_HTTP_SERVICE = "ocd-waker-http";

export const TRAEFIK_STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
/** JSON access log, one line per request. Rotated by logrotate (see
 *  traefikInstallScript) so a busy fleet never fills the disk. */
export const TRAEFIK_ACCESS_LOG_PATH = "/var/log/traefik/access.log";
export const TRAEFIK_LOGROTATE_PATH = "/etc/logrotate.d/ocd-traefik";
export const TRAEFIK_UNIT_PATH = "/etc/systemd/system/ocd-traefik.service";
export const TRAEFIK_DYNAMIC_DIR = "/etc/traefik/dynamic";
export const TRAEFIK_DYNAMIC_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/ocd.yml`;
export const TRAEFIK_PANEL_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/panel.yml`;
export const TRAEFIK_ACME_PATH = "/etc/traefik/acme.json";
/** Separate cert storage for the DNS-01 wildcard resolver — Traefik requires
 *  a distinct storage file per certificatesResolver (two resolvers sharing
 *  one acme.json corrupt each other's state). */
export const TRAEFIK_ACME_DNS_PATH = "/etc/traefik/acme-dns.json";
/** systemd EnvironmentFile carrying the Hetzner DNS token (HETZNER_API_KEY)
 *  for the wildcard resolver's lego provider. Delivered by the reconciler to
 *  the panel server ONLY (see traefik-manager.ts); the unit references it
 *  with a `-` prefix so workers without the file still boot. */
export const TRAEFIK_ENV_PATH = "/etc/traefik/traefik.env";

/** Entrypoint carrying an app's public raw TCP/UDP port (`pub30001`,
 *  `pubu30050`, …). One per port in the two public pool blocks. */
export function publicPortEntrypoint(port: number, protocol: "tcp" | "udp"): string {
  return protocol === "udp" ? `pubu${port}` : `pub${port}`;
}
