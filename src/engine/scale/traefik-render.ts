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
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import {
  BASIC_AUTH_USER,
  WAKER_HTTP_PORT,
  WAKER_HTTP_SERVICE,
  wakerTcpPort,
  wakerUdpPort,
  entrypointName,
  publicPortEntrypoint,
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
  name: string;
  /** Public domain; "" for private apps. */
  domain: string;
  internalPort: number;
  /** Explicit internal routing protocol: 'http' → HTTP router, 'tcp' → raw TCP
   *  router. Auth-protected apps are forced HTTP regardless (see httpRouted). */
  internalProtocol: "http" | "tcp";
  /** health_check flag: drives the active HTTP health-check probe target only
   *  (loadBalancer.healthCheck), NOT the routing protocol. */
  httpProbe: boolean;
  isPublic: boolean;
  /** sleeping/waking — all of the app's routers (internal, public HTTP, public
   *  raw TCP/UDP) point at the panel waker instead of a replica pool, so any
   *  connection transparently wakes it and is held-and-forwarded. */
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

export type DesiredService = {
  name: string;
  domain: string;
  /** `<private-ip>:<host-port>` — services are single-instance. */
  upstream: string;
};

export type DesiredState = {
  apps: DesiredApp[];
  services: DesiredService[];
  /** The panel container's host port on the panel server's loopback. Null when
   *  no panel. No longer consumed by the renderer (sleeping apps route to the
   *  waker, not the panel) — retained in the snapshot for callers/tests. */
  panelHostPort: number | null;
  /** The panel server's private IPv4 — where every server's Traefik reaches the
   *  waker (`<ip>:<waker-port>`) to route sleeping apps. Null until the network
   *  reconciler has attached the panel; sleeping apps then render no waker
   *  route (they fall back to rendering nothing, as before). */
  panelPrivateIpv4: string | null;
  /** Managed DNS zone name (settings `dns_zone_name`); "" when none. Drives
   *  the wildcard-cert TLS selection in publicTls — threaded through the
   *  snapshot so the renderer stays pure. */
  zoneName: string;
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
      name: app.name,
      domain: app.domain,
      internalPort: app.internal_port,
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

  const services: DesiredService[] = [];
  for (const svc of db.getServices()) {
    const catalog = getCatalogEntry(svc.service_type);
    if (!catalog?.http) continue;
    let domain = "";
    try {
      domain = String(JSON.parse(svc.credentials)?.domain || "");
    } catch {
      // malformed credentials — no ingress
    }
    if (!domain) continue;
    const instance = db.getServiceInstances(svc.id)[0];
    if (!instance) continue;
    const server = db.getServer(instance.server_id);
    if (!server?.private_ipv4) continue;
    services.push({
      name: svc.name,
      domain,
      upstream: `${server.private_ipv4}:${instance.host_port}`,
    });
  }
  services.sort((a, b) => a.name.localeCompare(b.name));

  const panel = db.getPanel();
  const panelServer = panel ? db.getServer(panel.server_id) : null;
  return {
    apps,
    services,
    panelHostPort: panel?.host_port ?? null,
    panelPrivateIpv4: panelServer?.private_ipv4 || null,
    zoneName: db.getSettings()["dns_zone_name"] ?? "",
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
 *   - `<zone>` or one label under it — the shared `*.<zone>` wildcard cert
 *                        via DNS-01 (`letsencrypt-dns`): instant TLS on
 *                        deploy for auto-domains, one cert, no LE rate-limit
 *                        exposure. `*.<zone>` covers exactly ONE label, so
 *                        multi-level subdomains (a.b.zone) fall through.
 *   - anything else    — per-domain HTTP-01 (`letsencrypt`), as before.
 */
export function publicTls(domain: string, zoneName: string): TlsConfig {
  if (domain.endsWith(".nip.io")) return {};
  if (zoneName && (domain === zoneName || domain.endsWith(`.${zoneName}`))) {
    const label = domain === zoneName ? "" : domain.slice(0, -(zoneName.length + 1));
    if (!label.includes(".")) {
      return {
        certResolver: "letsencrypt-dns",
        domains: [{ main: zoneName, sans: [`*.${zoneName}`] }],
      };
    }
  }
  return { certResolver: "letsencrypt" };
}

/**
 * The app's HTTP service loadBalancer. Per-app ingress options that live on
 * the service rather than a router go here:
 *
 *   - sticky sessions — Traefik only supports stickiness at the service
 *     level, and each app has exactly ONE HTTP service shared by its public
 *     and internal routers, so the cookie affinity applies to both. That's
 *     acceptable: internal callers that ignore the Set-Cookie simply keep
 *     getting load-balanced.
 *   - active HTTP health check — failing replicas leave rotation between
 *     reconciler ticks instead of relying on retry-based failover. Gated on
 *     the health_check probe flag; TCP-routed apps (internal_protocol='tcp')
 *     keep the TCP connect check on their tcp service instead.
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
 * Every server gets the internal routers (per-app entrypoint); only the
 * panel (`isPanel`) additionally gets public routers: app domains,
 * managed-service domains, and the global web→websecure redirect.
 *
 * A SLEEPING app (no servable upstreams) does not disappear — every one of its
 * routers (internal HTTP/TCP, public HTTP, public raw TCP/UDP) is pointed at
 * the panel WAKER instead of a replica pool, so any connection transparently
 * wakes the app and is held-and-forwarded (see the waker header above and
 * waker.ts). The reconciler re-renders back to real replicas once it wakes.
 * The only case that still renders nothing is a sleeping app before the panel
 * has a private IP (panelPrivateIpv4 null) — there is nowhere to route yet.
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
  const tcpRouters: Record<string, unknown> = {};
  const tcpServices: Record<string, unknown> = {};
  const udpRouters: Record<string, unknown> = {};
  const udpServices: Record<string, unknown> = {};

  let needRetry = false;
  let needSecHeaders = false;
  let needSvcHeaders = false;
  // Whether any router pointed at the shared waker HTTP service this render, so
  // the one load balancer to `<panel-private-ip>:WAKER_HTTP_PORT` is emitted.
  let needWakerHttp = false;
  const wakerIp = state.panelPrivateIpv4;

  for (const app of state.apps) {
    const svcName = `app-${app.name}`;
    const hasUpstreams = app.upstreams.length > 0;
    // A sleeping app routes to the waker instead of a replica pool — but only
    // once the panel has a private IP to reach it at. Without one there is
    // nowhere to route, so it renders nothing (the pre-waker fallback).
    const routeToWaker = app.asleep && wakerIp != null;
    // Does this app render any routers this pass? Awake apps with a servable
    // pool, or sleeping apps we can point at the waker.
    const renders = hasUpstreams || routeToWaker;

    // basicAuth middleware for password-protected apps, attached to every HTTP
    // router — internal traffic went through the old auth proxy too, so the
    // protection surface is unchanged. Rendered for sleeping apps too: Traefik
    // enforces basicAuth *before* forwarding to the waker, so a password-gated
    // app can't be woken or reached unauthenticated during its cold start.
    const authMiddlewares: string[] = [];
    if (app.authHash && renders) {
      httpMiddlewares[`auth-${app.name}`] = {
        basicAuth: { users: [`${BASIC_AUTH_USER}:${app.authHash}`] },
      };
      authMiddlewares.push(`auth-${app.name}`);
    }

    // Routing protocol is the explicit internal_protocol field. Auth-protected
    // apps are always HTTP-routed even when internal_protocol='tcp': basicAuth
    // only exists for HTTP routers, and a raw TCP router would silently bypass
    // the password. New deploys reject the auth+tcp combo (see
    // validateDeployRequest); this keeps any pre-existing rows protected.
    const httpRouted = app.internalProtocol === "http" || !!app.authHash;

    if (renders && httpRouted) {
      // Internal HTTP router on every server: the app's own entrypoint. Awake →
      // the replica pool; asleep → the shared waker HTTP service (resolves the
      // app from the forwarded `<app>.ocd.internal` Host, holds, forwards).
      if (routeToWaker) {
        needWakerHttp = true;
      } else {
        httpServices[svcName] = { loadBalancer: httpLoadBalancer(app) };
      }
      httpRouters[`int-${app.name}`] = {
        entryPoints: [entrypointName(app.internalPort)],
        rule: "PathPrefix(`/`)",
        middlewares: [...authMiddlewares, "retry"],
        service: routeToWaker ? WAKER_HTTP_SERVICE : svcName,
      };
      needRetry = true;
    } else if (renders) {
      // internal_protocol='tcp': raw TCP pass-through. Awake → the replica pool
      // with active TCP health checks (the direct replacement for Caddy's
      // passive checks; requires Traefik >= 3.5). Asleep → the app's dedicated
      // waker TCP port (the waker resolves the app from the port, holds, pipes).
      if (routeToWaker) {
        tcpServices[svcName] = {
          loadBalancer: { servers: [{ address: `${wakerIp}:${wakerTcpPort(app.internalPort)}` }] },
        };
      } else {
        tcpServices[svcName] = {
          loadBalancer: {
            servers: app.upstreams.map((u) => ({ address: u })),
            healthCheck: { interval: "10s", timeout: "3s" },
          },
        };
      }
      tcpRouters[`int-${app.name}`] = {
        entryPoints: [entrypointName(app.internalPort)],
        rule: "HostSNI(`*`)",
        service: svcName,
      };
    }

    // Public raw TCP/UDP exposure (apps.public_port): panel only — the panel
    // owns the public ingress IP. Deliberately independent of isPublic/domain
    // (an HTTP-private app can still be TCP-exposed, e.g. a database) and of
    // basicAuth (raw sockets have no HTTP auth; the user opted into raw
    // exposure explicitly). Raw pass-through, no TLS termination. Sleeping apps
    // now route to the app's dedicated waker port instead of dropping the route
    // — this is the case that previously simply failed until woken elsewhere.
    if (opts.isPanel && app.publicPort != null && renders) {
      if (app.publicProtocol === "udp") {
        // UDP has no routing rule concept and UDP loadBalancers support no
        // health checks — the emitted shape is just entrypoint → dial pool.
        udpRouters[`pubudp-${app.name}`] = {
          entryPoints: [publicPortEntrypoint(app.publicPort, "udp")],
          service: `pubudp-${app.name}`,
        };
        udpServices[`pubudp-${app.name}`] = {
          loadBalancer: {
            servers: routeToWaker
              ? [{ address: `${wakerIp}:${wakerUdpPort(app.internalPort)}` }]
              : app.upstreams.map((u) => ({ address: u })),
          },
        };
      } else {
        tcpRouters[`pubtcp-${app.name}`] = {
          entryPoints: [publicPortEntrypoint(app.publicPort, "tcp")],
          rule: "HostSNI(`*`)",
          service: `pubtcp-${app.name}`,
        };
        tcpServices[`pubtcp-${app.name}`] = {
          loadBalancer: routeToWaker
            ? { servers: [{ address: `${wakerIp}:${wakerTcpPort(app.internalPort)}` }] }
            : {
                servers: app.upstreams.map((u) => ({ address: u })),
                healthCheck: { interval: "10s", timeout: "3s" },
              },
        };
      }
    }

    // Public route: panel only, public apps with a domain, that render at all.
    if (!opts.isPanel || !app.isPublic || !app.domain || !renders) continue;

    // Public-only middleware chain, cheapest rejection first: the IP allowlist
    // and rate limit turn unwanted traffic away before basicAuth spends bcrypt
    // CPU verifying it (an unauthenticated flood must not become a hashing
    // DoS); compress and sec-headers only shape responses that made it through.
    // Built identically whether the router points at the replicas (awake) or
    // the waker (asleep) — the allowlist and password must gate the wake too.
    // Internal routers skip all of this except auth — app-to-app is trusted.
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
    pubMiddlewares.push(...authMiddlewares);
    if (app.compress) {
      httpMiddlewares[`compress-${app.name}`] = { compress: {} };
      pubMiddlewares.push(`compress-${app.name}`);
    }

    if (routeToWaker) {
      // Sleeping: the domain resolves to the waker, which wakes+holds+forwards.
      needWakerHttp = true;
    } else if (!httpServices[svcName]) {
      // Awake: the public router proxies HTTP to the replicas even for
      // internal_protocol='tcp' apps (same as the old public vhost), so make
      // sure an HTTP service exists for TCP-routed apps too.
      httpServices[svcName] = { loadBalancer: httpLoadBalancer(app) };
    }
    httpRouters[`pub-${app.name}`] = {
      entryPoints: ["websecure"],
      rule: `Host(\`${app.domain}\`)`,
      middlewares: [...pubMiddlewares, "sec-headers", "retry"],
      service: routeToWaker ? WAKER_HTTP_SERVICE : svcName,
      tls: publicTls(app.domain, state.zoneName),
    };
    needRetry = true;
    needSecHeaders = true;
  }

  // Managed services: single-upstream public vhosts on the panel.
  if (opts.isPanel) {
    for (const svc of state.services) {
      const svcName = `svc-${svc.name}`;
      httpServices[svcName] = {
        loadBalancer: { servers: [{ url: `http://${svc.upstream}` }] },
      };
      httpRouters[svcName] = {
        entryPoints: ["websecure"],
        rule: `Host(\`${svc.domain}\`)`,
        middlewares: ["svc-headers", "retry"],
        service: svcName,
        tls: publicTls(svc.domain, state.zoneName),
      };
      needRetry = true;
      needSvcHeaders = true;
    }

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
  if (needSvcHeaders) {
    httpMiddlewares["svc-headers"] = {
      headers: {
        customResponseHeaders: {
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "strict-origin-when-cross-origin",
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
  const tcp: Record<string, unknown> = {};
  if (Object.keys(tcpRouters).length) tcp.routers = sortKeys(tcpRouters);
  if (Object.keys(tcpServices).length) tcp.services = sortKeys(tcpServices);
  if (Object.keys(tcp).length) config.tcp = tcp;
  const udp: Record<string, unknown> = {};
  if (Object.keys(udpRouters).length) udp.routers = sortKeys(udpRouters);
  if (Object.keys(udpServices).length) udp.services = sortKeys(udpServices);
  if (Object.keys(udp).length) config.udp = udp;
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
  zoneName: string,
): string {
  const config = {
    http: {
      routers: {
        panel: {
          entryPoints: ["websecure"],
          rule: `Host(\`${domain}\`)`,
          service: "panel",
          // Same TLS selection as app vhosts: a panel domain under the
          // managed zone rides the wildcard cert; nip.io self-signs.
          tls: publicTls(domain, zoneName),
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
