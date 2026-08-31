// Traefik dynamic-config render — the desired-state half of the ingress stack.
// Snapshots DB routing state (collectDesiredState) and renders the per-server
// /etc/traefik/dynamic/ocd.yml + the panel's panel.yml from it. Pure: no
// network, no SSH. traefik-provision.ts owns the static config; traefik-manager.ts
// owns delivery.
//
// Dynamic state lives in /etc/traefik/dynamic/ocd.yml, re-rendered from the DB
// as a whole (desired-state, not incremental edits) and picked up by the file
// provider's watcher. The panel's own vhost lives in a separate panel.yml owned
// by bootstrap (see deployTraefikPanelSite) — app syncs never disturb panel
// WebSocket/terminal sessions.
//
// All emitted "YAML" is JSON (JSON is valid YAML) — no serializer dependency.

import * as db from "../../shared/db.ts";
import {
  BASIC_AUTH_USER,
  WAKER_HTTP_PORT,
  WAKER_HTTP_SERVICE,
} from "./traefik-constants.ts";

/** Return an object with keys inserted in sorted order — JSON.stringify then
 *  emits them deterministically, which the content-hash sync cache relies on. */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// --- Desired state -----------------------------------------------------------

export type DesiredApp = {
  /** apps.id — carried for the VIP proxy's wake contract (Traefik rendering
   *  keys everything on name and ignores this). */
  appId: number;
  name: string;
  /** Public domain; "" for private apps. */
  domain: string;
  internalPort: number;
  /** Fleet-unique per-app VIP (apps.virtual_ip); "" when unallocated. Consumed
   *  by the ocd-proxy renderer only — Traefik rendering ignores it. */
  virtualIp: string;
  /** The container's own listening port — a VIP listener alias so URLs baked
   *  against the container port keep working. Ignored by Traefik rendering. */
  containerPort: number;
  /** Explicit internal routing protocol; consumed by the ocd-proxy renderer
   *  (drives frontPorts / the env URL scheme). Traefik rendering ignores it. */
  internalProtocol: "http" | "tcp";
  /** health_check flag: drives the active HTTP health-check probe target only
   *  (loadBalancer.healthCheck), NOT the routing protocol. */
  httpProbe: boolean;
  isPublic: boolean;
  /** sleeping/waking — the app's public HTTP router points at the panel waker
   *  instead of a replica pool, so a public connection transparently wakes it
   *  and is held-and-forwarded. (Internal wake is the VIP proxy's job.) */
  asleep: boolean;
  /** htpasswd bcrypt hash for the basicAuth middleware; "" when the app has
   *  no password. Persisted at set-time (apps.auth_password_hash) so renders
   *  are deterministic — hashing per render would salt differently every
   *  time and defeat the content-hash sync cache. */
  authHash: string;
  /** Sticky sessions: cookie-pinned replica affinity on the HTTP service. */
  sticky: boolean;
  /** Public-router rate limit in req/s; 0 = off. */
  rateLimitRps: number;
  /** IPs/CIDRs allowed through the public router; empty = open. Parsed from
   *  the validated comma-separated apps.ip_allowlist. */
  ipAllowlist: string[];
  /** Active HTTP health-check path (HTTP apps only); "" = off. */
  healthCheckPath: string;
  /** Response compression on the public router. */
  compress: boolean;
  /** Public raw TCP/UDP port on the panel IP; null = not exposed. */
  publicPort: number | null;
  publicProtocol: "tcp" | "udp";
  /** `<private-ip>:<port>` dial strings, sorted. */
  upstreams: string[];
};

export type DesiredState = {
  apps: DesiredApp[];
  /** The panel container's host port on the panel server's loopback. Null when
   *  no panel. No longer consumed by the renderer (sleeping apps route to the
   *  waker, not the panel) — retained in the snapshot for callers/tests. */
  panelHostPort: number | null;
  /** The panel server's private IPv4 — where every server's Traefik reaches the
   *  waker (`<ip>:<waker-port>`) to route sleeping apps. Null until the network
   *  reconciler has attached the panel; sleeping apps then render no waker
   *  route (they fall back to rendering nothing, as before). */
  panelPrivateIpv4: string | null;
  /** The panel server's PUBLIC IPv4 — the DNAT `daddr` the VIP proxy keys the
   *  public raw path on, so the fleet-wide-identical proxy config only
   *  intercepts 30000-30099 on the panel. Null until a panel server exists.
   *  Consumed by the ocd-proxy renderer only; Traefik rendering ignores it. */
  panelPublicIpv4: string | null;
};

/**
 * Upstream pool for an app. Includes only replicas the DB currently considers
 * servable: `running` and `unhealthy`. Explicitly excluded:
 *
 *   - `stopped`    — scale-to-zero anchor, container is off.
 *   - `paused`     — `docker pause` froze the container; it accepts TCP
 *                    but won't serve.
 *   - `draining`   — scale-down has signalled the replica to quiesce.
 *   - `deploying`  — container hasn't finished starting yet.
 *
 * `unhealthy` stays in the pool: the retry middleware (HTTP) / TCP health
 * check skips it per-request, and if it stays failing the reconciler
 * auto-restarts it.
 */
export function buildUpstreams(appId: number): string[] {
  const replicas = db
    .getReplicas(appId)
    .filter((r) => r.status === "running" || r.status === "unhealthy");
  const ups: string[] = [];
  for (const replica of replicas) {
    const server = db.getServer(replica.server_id);
    if (!server) continue;
    // Only servers attached to the shared private network can serve this
    // app — the container is bound to the private IP. A server without one
    // gets silently skipped; the network reconciler backfills it on the
    // next tick and the ingress sync picks it up from there.
    if (!server.private_ipv4) continue;
    ups.push(`${server.private_ipv4}:${replica.host_port}`);
  }
  return ups.sort();
}

/** Snapshot everything the dynamic-config renderer needs from the DB. */
export function collectDesiredState(): DesiredState {
  const apps: DesiredApp[] = db
    .getApps()
    .map((app) => ({
      appId: app.id,
      name: app.name,
      domain: app.domain,
      internalPort: app.internal_port,
      virtualIp: app.virtual_ip || "",
      containerPort: app.container_port,
      internalProtocol: app.internal_protocol === "tcp" ? "tcp" as const : "http" as const,
      httpProbe: !!app.health_check,
      isPublic: !!app.public,
      asleep: app.status === "sleeping" || app.status === "waking",
      authHash: app.auth_password_hash || "",
      sticky: !!app.sticky,
      rateLimitRps: app.rate_limit_rps || 0,
      ipAllowlist: app.ip_allowlist.split(",").map((e) => e.trim()).filter(Boolean),
      healthCheckPath: app.health_check_path || "",
      compress: !!app.compress,
      publicPort: app.public_port ?? null,
      publicProtocol: app.public_protocol === "udp" ? "udp" as const : "tcp" as const,
      upstreams: buildUpstreams(app.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const panel = db.getPanel();
  const panelServer = panel ? db.getServer(panel.server_id) : null;
  return {
    apps,
    panelHostPort: panel?.host_port ?? null,
    panelPrivateIpv4: panelServer?.private_ipv4 || null,
    panelPublicIpv4: panelServer?.ipv4 || null,
  };
}

// --- Dynamic config render -----------------------------------------------------

type TlsConfig = Record<string, unknown>;

/**
 * TLS config for a public router, by domain:
 *
 *   - nip.io           — can't get Let's Encrypt certs; `tls: {}` serves
 *                        Traefik's built-in default self-signed certificate
 *                        instead of a handshake error.
 *   - anything else    — per-domain HTTP-01 (`letsencrypt`).
 */
export function publicTls(domain: string): TlsConfig {
  if (domain.endsWith(".nip.io")) return {};
  return { certResolver: "letsencrypt" };
}

/**
 * The app's HTTP service loadBalancer. Per-app ingress options that live on
 * the service rather than a router go here:
 *
 *   - sticky sessions — Traefik only supports stickiness at the service
 *     level; each app has exactly ONE HTTP service (its public router's).
 *   - active HTTP health check — failing replicas leave rotation between
 *     reconciler ticks instead of relying on retry-based failover. Gated on
 *     the health_check probe flag.
 */
function httpLoadBalancer(app: DesiredApp): Record<string, unknown> {
  const lb: Record<string, unknown> = {
    servers: app.upstreams.map((u) => ({ url: `http://${u}` })),
  };
  if (app.sticky) {
    lb.sticky = {
      cookie: { name: "ocd_sticky", httpOnly: true, secure: true, sameSite: "lax" },
    };
  }
  if (app.httpProbe && app.healthCheckPath) {
    lb.healthCheck = { path: app.healthCheckPath, interval: "10s", timeout: "3s" };
  }
  return lb;
}

/**
 * Render /etc/traefik/dynamic/ocd.yml from a desired-state snapshot.
 *
 * Traefik now carries public HTTP ingress only — internal app-to-app traffic
 * AND the public raw TCP/UDP pool (30000-30099) are both owned by the per-host
 * VIP proxy (src/proxy/). Only the panel (`isPanel`) renders routers: public
 * app domains and the global web→websecure redirect.
 * Workers get an empty config.
 *
 * A SLEEPING public app does not disappear — its domain router is pointed at
 * the panel WAKER instead of a replica pool, so any HTTP connection
 * transparently wakes the app and is held-and-forwarded (see waker.ts). The
 * reconciler re-renders back to real replicas once it wakes; before the panel
 * has a private IP there is nowhere to route, so it renders nothing.
 *
 * Output key order is deterministic so the manager's content-hash cache can
 * skip no-op writes.
 */
export function renderDynamicConfig(
  state: DesiredState,
  opts: { isPanel: boolean },
): string {
  const httpRouters: Record<string, unknown> = {};
  const httpMiddlewares: Record<string, unknown> = {};
  const httpServices: Record<string, unknown> = {};

  let needRetry = false;
  let needSecHeaders = false;
  // Whether any router pointed at the shared waker HTTP service this render, so
  // the one load balancer to `<panel-private-ip>:WAKER_HTTP_PORT` is emitted.
  let needWakerHttp = false;
  const wakerIp = state.panelPrivateIpv4;

  for (const app of state.apps) {
    const svcName = `app-${app.name}`;
    const hasUpstreams = app.upstreams.length > 0;
    // A sleeping app's public domain routes to the waker instead of a replica
    // pool — but only once the panel has a private IP to reach it at. Without
    // one there is nowhere to route, so it renders nothing.
    const routeToWaker = app.asleep && wakerIp != null;

    // NOTE: public raw TCP/UDP exposure (apps.public_port, the 30000-30099
    // pool) no longer routes through Traefik — the per-host VIP proxy owns it
    // now (a dedicated auth-free public listener plus panel-scoped nftables
    // DNAT; see src/proxy/ and proxy-render.ts). That path also gains working
    // wake-on-connect, which Traefik's L4-passthrough entrypoints never had.

    // Public route: panel only, public apps with a domain, awake with a
    // servable pool or asleep with a reachable waker.
    if (!opts.isPanel || !app.isPublic || !app.domain || !(hasUpstreams || routeToWaker)) continue;

    // Public middleware chain, cheapest rejection first: the IP allowlist
    // and rate limit turn unwanted traffic away before basicAuth spends bcrypt
    // CPU verifying it (an unauthenticated flood must not become a hashing
    // DoS); compress and sec-headers only shape responses that made it through.
    // Built identically whether the router points at the replicas (awake) or
    // the waker (asleep) — the allowlist and password must gate the wake too.
    const pubMiddlewares: string[] = [];
    if (app.ipAllowlist.length > 0) {
      httpMiddlewares[`allowlist-${app.name}`] = {
        ipAllowList: { sourceRange: app.ipAllowlist },
      };
      pubMiddlewares.push(`allowlist-${app.name}`);
    }
    if (app.rateLimitRps > 0) {
      httpMiddlewares[`ratelimit-${app.name}`] = {
        rateLimit: { average: app.rateLimitRps, burst: app.rateLimitRps * 2 },
      };
      pubMiddlewares.push(`ratelimit-${app.name}`);
    }
    if (app.authHash) {
      httpMiddlewares[`auth-${app.name}`] = {
        basicAuth: { users: [`${BASIC_AUTH_USER}:${app.authHash}`] },
      };
      pubMiddlewares.push(`auth-${app.name}`);
    }
    if (app.compress) {
      httpMiddlewares[`compress-${app.name}`] = { compress: {} };
      pubMiddlewares.push(`compress-${app.name}`);
    }

    if (routeToWaker) {
      // Sleeping: the domain resolves to the waker, which wakes+holds+forwards.
      needWakerHttp = true;
    } else {
      // Awake: the public router proxies HTTP to the replicas even for
      // internal_protocol='tcp' apps (same as the old public vhost).
      httpServices[svcName] = { loadBalancer: httpLoadBalancer(app) };
    }
    httpRouters[`pub-${app.name}`] = {
      entryPoints: ["websecure"],
      rule: `Host(\`${app.domain}\`)`,
      middlewares: [...pubMiddlewares, "sec-headers", "retry"],
      service: routeToWaker ? WAKER_HTTP_SERVICE : svcName,
      tls: publicTls(app.domain),
    };
    needRetry = true;
    needSecHeaders = true;
  }

  if (opts.isPanel) {
    // Global web→websecure redirect. ACME HTTP-01 bypasses it automatically;
    // priority 1 lets any explicit :80 router (panel.yml) win over it.
    httpRouters["web-to-https"] = {
      entryPoints: ["web"],
      rule: "PathPrefix(`/`)",
      priority: 1,
      middlewares: ["redirect-https"],
      service: "noop@internal",
    };
    httpMiddlewares["redirect-https"] = {
      redirectScheme: { scheme: "https", permanent: true },
    };
  }

  if (needWakerHttp && wakerIp) {
    // One shared load balancer for every sleeping app's HTTP router, pointing
    // at the panel waker's HTTP listener over the private network. passHostHeader
    // defaults on, so the waker sees the original `<app>.ocd.internal` / public
    // domain Host and resolves the app from it.
    httpServices[WAKER_HTTP_SERVICE] = {
      loadBalancer: { servers: [{ url: `http://${wakerIp}:${WAKER_HTTP_PORT}` }] },
    };
  }
  if (needRetry) {
    // Traefik has no passive health checks for HTTP upstreams (Caddy's
    // fail_duration model) — retry approximates the per-request failover;
    // the reconciler's auto-restart handles persistently sick replicas.
    httpMiddlewares["retry"] = { retry: { attempts: 3 } };
  }
  if (needSecHeaders) {
    httpMiddlewares["sec-headers"] = {
      headers: {
        customResponseHeaders: {
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "X-XSS-Protection": "1; mode=block",
        },
      },
    };
  }

  const config: Record<string, unknown> = {};
  const http: Record<string, unknown> = {};
  if (Object.keys(httpRouters).length) http.routers = sortKeys(httpRouters);
  if (Object.keys(httpMiddlewares).length) http.middlewares = sortKeys(httpMiddlewares);
  if (Object.keys(httpServices).length) http.services = sortKeys(httpServices);
  if (Object.keys(http).length) config.http = http;
  return JSON.stringify(config, null, 2);
}

/**
 * Render /etc/traefik/dynamic/panel.yml — the panel's own vhost. Owned by
 * bootstrap/redeploy and never rewritten by the ocd.yml renderer, so panel
 * WebSocket/terminal sessions are never disturbed by app syncs. All names in
 * here (`panel`, `panel-web`, `panel-redirect-https`) are disjoint from the
 * ocd.yml namespace (`app-*`, `svc-*`, `ocd-waker-http`, …) — the file provider
 * rejects duplicate definitions across files.
 */
export function renderPanelConfig(
  domain: string,
  hostPort: number,
): string {
  const config = {
    http: {
      routers: {
        panel: {
          entryPoints: ["websecure"],
          rule: `Host(\`${domain}\`)`,
          service: "panel",
          tls: publicTls(domain),
        },
        // Explicit :80 redirect so the panel redirects even before the
        // engine writes ocd.yml's global redirect (bootstrap ordering).
        "panel-web": {
          entryPoints: ["web"],
          rule: `Host(\`${domain}\`)`,
          middlewares: ["panel-redirect-https"],
          service: "panel",
        },
      },
      middlewares: {
        "panel-redirect-https": {
          redirectScheme: { scheme: "https", permanent: true },
        },
      },
      services: {
        panel: {
          loadBalancer: { servers: [{ url: `http://127.0.0.1:${hostPort}` }] },
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
