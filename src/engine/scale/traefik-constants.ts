// Shared Traefik constants and pure name/port helpers. Both halves of the
// ingress stack depend on these: traefik-provision.ts (bash static-config /
// systemd / install generators) and traefik-render.ts (desired-state + dynamic
// YAML render). Kept dependency-light (only db, for the internal-port base) so
// neither half has to import the other.

import * as db from "../../shared/db.ts";

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
// belongs to the WAKER, an in-process TCP/HTTP proxy that runs on the PANEL
// (src/engine/scale/waker.ts). While an app sleeps, its Traefik routers point
// at the waker instead of a (non-existent) replica pool; when it wakes, the
// reconciler re-renders them back to the real replicas. This replaced the old
// browser-only 503 "wake page", which did nothing for internal callers, raw
// TCP/UDP ports, or any non-browser HTTP client.
//
// Topology: ONE waker on the panel (like public ingress, which already
// centralizes there). Every server's Traefik reaches it over the private
// network at `<panel-private-ip>:<waker-port>`. Tradeoff: the panel is a wake
// choke point / SPOF for cold starts — but it is already the choke point for
// all public ingress, ACME and the control plane, so this adds no new failure
// domain. The alternative (a waker per server) would duplicate the DB access
// and wake coordination on every worker for no real gain.

/** The waker's single HTTP listener. Sleeping apps' HTTP routers (internal
 *  `<app>.ocd.internal:<port>` and public `<domain>`) forward here; the waker
 *  resolves the app from the forwarded `Host` header, wakes it, holds the
 *  request, then proxies to the real upstream. */
export const WAKER_HTTP_PORT = 8896;

/** Base of the waker's per-app raw-TCP listener block. A sleeping raw-TCP app
 *  (internal_protocol='tcp', or one exposed on a public `pub*` port) gets a
 *  dedicated waker port = WAKER_TCP_PORT_BASE + (internal_port - base); the
 *  waker resolves the app from the port a connection arrived on (raw sockets
 *  carry no Host). Mirrors the int20000-20199 block 1:1, so the port is stable
 *  for the app's lifetime and never collides. */
export const WAKER_TCP_PORT_BASE = 21000;

/** Base of the waker's per-app UDP listener block (public `pubu*` ports),
 *  offset past the TCP block so the two never overlap. */
export const WAKER_UDP_PORT_BASE = 21200;

/** Waker raw-TCP port for an app, derived from its internal port. Shared by the
 *  app's internal-tcp and public-tcp sleeping routers — both dial the same
 *  upstream once awake, so one listener serves both. */
export function wakerTcpPort(internalPort: number): number {
  return WAKER_TCP_PORT_BASE + (internalPort - db.INTERNAL_PORT_BASE);
}

/** Waker UDP port for an app, derived from its internal port. */
export function wakerUdpPort(internalPort: number): number {
  return WAKER_UDP_PORT_BASE + (internalPort - db.INTERNAL_PORT_BASE);
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

export function entrypointName(internalPort: number): string {
  return `int${internalPort}`;
}

/** Entrypoint carrying an app's public raw TCP/UDP port (`pub30001`,
 *  `pubu30050`, …). One per port in the two public pool blocks. */
export function publicPortEntrypoint(port: number, protocol: "tcp" | "udp"): string {
  return protocol === "udp" ? `pubu${port}` : `pub${port}`;
}

function internalHost(appName: string): string {
  return `${appName}.ocd.internal`;
}

/**
 * Stable URL an app can use to reach another app over the local Traefik's
 * per-app internal entrypoint. Callers should use this in env vars / service
 * discovery.
 */
export function internalAppUrl(appName: string, internalPort: number): string {
  return `http://${internalHost(appName)}:${internalPort}`;
}
