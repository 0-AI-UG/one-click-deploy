// Traefik config generation — the pure half of the ingress stack. This module
// turns DB state into Traefik config strings and never touches the network;
// traefik-manager.ts owns delivery (SSH writes, install, caching).
//
// One Traefik instance runs on *every* server (systemd unit `ocd-traefik`)
// with an identical static config:
//
//   web / websecure   — :80/:443 public ingress. Only the panel server ever
//                       gets routers on these (public app domains, managed
//                       services, ACME); on workers they sit idle.
//   int20000-int20199 — one entrypoint per app `internal_port`. HTTP apps get
//                       an HTTP router, health_check=0 apps a raw TCP router,
//                       so one address `<app>.ocd.internal:<internal_port>`
//                       works for both protocols.
//   pub30000-pub30049 / pubu30050-pubu30099 — public raw TCP/UDP pool
//                       (apps.public_port). Routed on the panel only:
//                       `<panel-ip>:<port>` forwards raw to the app's
//                       replicas over the private network.
//
// The 200-port block is fixed forever (it doubles as the fleet app cap).
// Static config rarely changes; when it does, the reconciler converges every
// server (rewrite + service restart) within one tick — steady-state ticks
// never restart. Dynamic state lives in /etc/traefik/dynamic/ocd.yml, re-rendered
// from the DB as a whole (desired-state, not incremental edits) and picked
// up by the file provider's watcher. The panel's own vhost lives in a
// separate panel.yml owned by bootstrap (see deployTraefikPanelSite) — app
// syncs never disturb panel WebSocket/terminal sessions.
//
// All emitted "YAML" is JSON (JSON is valid YAML) — no serializer dependency.

import * as db from "../../shared/db.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";

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

function entrypointName(internalPort: number): string {
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

/** Return an object with keys inserted in sorted order — JSON.stringify then
 *  emits them deterministically, which the content-hash sync cache relies on. */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// --- Static config -----------------------------------------------------------

/** Contact email for the Let's Encrypt account. Without one Traefik never
 *  reuses the account persisted in acme.json and registers a fresh LE account
 *  on every process start's first issuance — burning LE's 10-accounts/IP/3h
 *  limit under restart loops. Operator-set `acme_email` wins; else derive a
 *  stable address from the configured DNS zone; else none (nip.io-only
 *  fleets never issue). */
export function acmeEmail(): string {
  const settings = db.getSettings();
  if (settings["acme_email"]) return settings["acme_email"];
  if (settings["dns_zone_name"]) return `admin@${settings["dns_zone_name"]}`;
  return "";
}

/**
 * The static config installed at /etc/traefik/traefik.yml — identical on
 * every server in the fleet. Written at install time and kept converged by
 * the reconciler (reconcileTraefik compares content hashes and rewrites +
 * restarts on drift), so changes here roll out fleet-wide within one tick.
 * The ACME resolver is inert on workers: no router references it there.
 */
export function traefikStaticConfig(): string {
  const entryPoints: Record<string, { address: string }> = {
    web: { address: ":80" },
    websecure: { address: ":443" },
    // Prometheus metrics for the reconciler's per-tick scrape. Bound like the
    // other entrypoints, but the Hetzner cloud firewall only opens 22/80/443
    // publicly — same not-internet-reachable stance as the 20000-20199 block.
    metrics: { address: `:${TRAEFIK_METRICS_PORT}` },
  };
  for (
    let port = db.INTERNAL_PORT_BASE;
    port < db.INTERNAL_PORT_BASE + db.INTERNAL_PORT_COUNT;
    port++
  ) {
    entryPoints[entrypointName(port)] = { address: `:${port}` };
  }
  // Public raw TCP/UDP pool (apps.public_port). Reserved fleet-wide up front
  // because entrypoints are static-config-only — exposing an app must never
  // need a Traefik restart. Only the panel ever routes these; the base
  // firewall opens the block everywhere but on workers nothing listens.
  for (
    let port = db.PUBLIC_TCP_PORT_BASE;
    port < db.PUBLIC_TCP_PORT_BASE + db.PUBLIC_TCP_PORT_COUNT;
    port++
  ) {
    entryPoints[publicPortEntrypoint(port, "tcp")] = { address: `:${port}` };
  }
  for (
    let port = db.PUBLIC_UDP_PORT_BASE;
    port < db.PUBLIC_UDP_PORT_BASE + db.PUBLIC_UDP_PORT_COUNT;
    port++
  ) {
    entryPoints[publicPortEntrypoint(port, "udp")] = { address: `:${port}/udp` };
  }
  const email = acmeEmail();
  // Wildcard resolver only when a DNS zone is managed — `*.<zone>` needs
  // DNS-01, and without a zone there is nothing to issue for. The resolver
  // is inert on workers (no router references it there) and on the panel
  // until the reconciler delivers HETZNER_API_KEY via the env file.
  const zone = db.getSettings()["dns_zone_name"] ?? "";
  const config = {
    entryPoints,
    providers: {
      file: { directory: TRAEFIK_DYNAMIC_DIR, watch: true },
    },
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          ...(email ? { email } : {}),
          storage: TRAEFIK_ACME_PATH,
          httpChallenge: { entryPoint: "web" },
        },
      },
      ...(zone
        ? {
            "letsencrypt-dns": {
              acme: {
                ...(email ? { email } : {}),
                storage: TRAEFIK_ACME_DNS_PATH,
                dnsChallenge: { provider: "hetzner" },
              },
            },
          }
        : {}),
    },
    // Per-service request counters (traefik_service_requests_total) feed the
    // idle monitor's traffic-based sleep decisions.
    metrics: { prometheus: { entryPoint: "metrics" } },
    // JSON access log for per-request debugging across the fleet. Buffered
    // (flushed every ~100 lines) so logging never serializes request handling.
    accessLog: {
      filePath: TRAEFIK_ACCESS_LOG_PATH,
      format: "json",
      bufferingSize: 100,
    },
    api: { dashboard: false },
  };
  return JSON.stringify(config, null, 2);
}

/** systemd unit for the host-level Traefik. Restart=always — the proxy is
 *  the server's only ingress, it must survive crashes unattended. */
export function traefikSystemdUnit(): string {
  return `[Unit]
Description=OCD Traefik ingress
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=-${TRAEFIK_ENV_PATH}
ExecStart=/usr/local/bin/traefik --configFile=${TRAEFIK_STATIC_CONFIG_PATH}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Idempotent bash script that installs the pinned Traefik release and brings
 * the `ocd-traefik` service up. Shared verbatim by cloud-init (fresh
 * provisioning) and the reconciler's install backfill over SSH:
 * download the static binary (arch-detected, re-downloaded when the installed
 * version differs from the pin), write the static config, create the dynamic
 * dir, lock down acme.json, install the systemd unit. Ends with an
 * unconditional restart so binary/static-config updates actually take effect
 * on servers where the service is already running.
 */
export function traefikInstallScript(): string {
  return `set -e
TRAEFIK_ARCH=$(uname -m)
case "$TRAEFIK_ARCH" in
  x86_64) TRAEFIK_ARCH=amd64 ;;
  aarch64) TRAEFIK_ARCH=arm64 ;;
esac
if ! /usr/local/bin/traefik version 2>/dev/null | grep -q "${TRAEFIK_VERSION}"; then
  curl -fsSL -o /tmp/traefik.tar.gz "https://github.com/traefik/traefik/releases/download/v${TRAEFIK_VERSION}/traefik_v${TRAEFIK_VERSION}_linux_\${TRAEFIK_ARCH}.tar.gz"
  tar -xzf /tmp/traefik.tar.gz -C /tmp traefik
  install -m 755 /tmp/traefik /usr/local/bin/traefik
  rm -f /tmp/traefik.tar.gz /tmp/traefik
fi
mkdir -p ${TRAEFIK_DYNAMIC_DIR}
mkdir -p ${TRAEFIK_ACCESS_LOG_PATH.substring(0, TRAEFIK_ACCESS_LOG_PATH.lastIndexOf("/"))}
cat > ${TRAEFIK_LOGROTATE_PATH} <<'OCD_TRAEFIK_LOGROTATE'
${TRAEFIK_ACCESS_LOG_PATH} {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
OCD_TRAEFIK_LOGROTATE
cat > ${TRAEFIK_STATIC_CONFIG_PATH} <<'OCD_TRAEFIK_STATIC'
${traefikStaticConfig()}
OCD_TRAEFIK_STATIC
touch ${TRAEFIK_ACME_PATH} ${TRAEFIK_ACME_DNS_PATH}
chmod 600 ${TRAEFIK_ACME_PATH} ${TRAEFIK_ACME_DNS_PATH}
cat > ${TRAEFIK_UNIT_PATH} <<'OCD_TRAEFIK_UNIT'
${traefikSystemdUnit()}
OCD_TRAEFIK_UNIT
systemctl daemon-reload
systemctl enable ocd-traefik
systemctl restart ocd-traefik
`;
}

/**
 * Content of ${TRAEFIK_ENV_PATH}: the Hetzner API token the `letsencrypt-dns`
 * resolver's lego provider reads as HETZNER_API_KEY. Deliberately NOT part of
 * traefikInstallScript()/cloud-init — user data is shared verbatim by every
 * provisioned server and the secret belongs on the panel server only. The
 * reconciler delivers it there within one tick of first boot (wildcard
 * issuance simply starts a tick later on a fresh panel).
 */
export function traefikEnvFile(hetznerToken: string): string {
  return `HETZNER_API_KEY=${hetznerToken}`;
}

// --- Desired state -----------------------------------------------------------

export type DesiredApp = {
  name: string;
  /** Public domain; "" for private apps. */
  domain: string;
  internalPort: number;
  /** health_check flag: true → HTTP routing, false → raw TCP routing. */
  httpProbe: boolean;
  isPublic: boolean;
  /** sleeping/waking — the public domain routes to the panel's wake page. */
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
  /** The panel container's host port on the panel server's loopback —
   *  target for sleeping apps' wake-page routing. Null when no panel. */
  panelHostPort: number | null;
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
function buildUpstreams(appId: number): string[] {
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
  return {
    apps,
    services,
    panelHostPort: panel?.host_port ?? null,
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
 *     reconciler ticks instead of relying on retry-based failover. HTTP apps
 *     only; health_check=0 apps keep the TCP connect check on their tcp
 *     service (and their public HTTP fallback service has no probe target).
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
 * managed-service domains, the global web→websecure redirect, and wake-page
 * routing (sleeping public apps' domains point at the panel container, which
 * serves the 503 wake page from src/server/lib/wake-page.ts).
 *
 * Apps with zero servable upstreams render nothing — their routers simply
 * disappear from the file, which is the desired-state equivalent of the old
 * route removal calls. Output key order is deterministic so the manager's
 * content-hash cache can skip no-op writes.
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
  let needPanelService = false;

  for (const app of state.apps) {
    const svcName = `app-${app.name}`;
    const hasUpstreams = app.upstreams.length > 0;

    // basicAuth middleware for password-protected apps, attached to every
    // HTTP router — internal traffic went through the old auth proxy too,
    // so the protection surface is unchanged. Every router that takes
    // middlewares only renders when upstreams exist, so gating on that keeps
    // orphan middlewares out of the config (e.g. sleeping apps).
    const authMiddlewares: string[] = [];
    if (app.authHash && hasUpstreams) {
      httpMiddlewares[`auth-${app.name}`] = {
        basicAuth: { users: [`${BASIC_AUTH_USER}:${app.authHash}`] },
      };
      authMiddlewares.push(`auth-${app.name}`);
    }

    // Auth-protected apps are always HTTP-routed, even with health_check=0:
    // basicAuth only exists for HTTP routers, and the old auth proxy was an
    // HTTP server that every upstream (including TCP-routed ones) sat
    // behind, so such apps were already HTTP-only in practice. A raw TCP
    // router would silently bypass the password. New deploys reject the
    // combo (see validateDeployRequest); this keeps existing rows protected.
    const httpRouted = app.httpProbe || !!app.authHash;

    if (hasUpstreams && httpRouted) {
      httpServices[svcName] = { loadBalancer: httpLoadBalancer(app) };
      // Internal router on every server: the app's own entrypoint.
      httpRouters[`int-${app.name}`] = {
        entryPoints: [entrypointName(app.internalPort)],
        rule: "PathPrefix(`/`)",
        middlewares: [...authMiddlewares, "retry"],
        service: svcName,
      };
      needRetry = true;
    } else if (hasUpstreams) {
      // health_check=0: raw TCP pass-through with active TCP health checks —
      // the direct replacement for Caddy's passive checks in TCP mode
      // (requires Traefik >= 3.5).
      tcpServices[svcName] = {
        loadBalancer: {
          servers: app.upstreams.map((u) => ({ address: u })),
          healthCheck: { interval: "10s", timeout: "3s" },
        },
      };
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
    // exposure explicitly). Raw pass-through, no TLS termination. Sleeping
    // apps render no route: there is no wake-page equivalent for raw sockets,
    // so a connect to a sleeping app simply fails until it is woken by HTTP
    // traffic or the panel.
    if (opts.isPanel && app.publicPort != null && !app.asleep && hasUpstreams) {
      if (app.publicProtocol === "udp") {
        // UDP has no routing rule concept and UDP loadBalancers support no
        // health checks — the emitted shape is just entrypoint → dial pool.
        udpRouters[`pubudp-${app.name}`] = {
          entryPoints: [publicPortEntrypoint(app.publicPort, "udp")],
          service: `pubudp-${app.name}`,
        };
        udpServices[`pubudp-${app.name}`] = {
          loadBalancer: {
            servers: app.upstreams.map((u) => ({ address: u })),
          },
        };
      } else {
        tcpRouters[`pubtcp-${app.name}`] = {
          entryPoints: [publicPortEntrypoint(app.publicPort, "tcp")],
          rule: "HostSNI(`*`)",
          service: `pubtcp-${app.name}`,
        };
        tcpServices[`pubtcp-${app.name}`] = {
          loadBalancer: {
            servers: app.upstreams.map((u) => ({ address: u })),
            healthCheck: { interval: "10s", timeout: "3s" },
          },
        };
      }
    }

    // Public route: panel only, public apps with a domain.
    if (!opts.isPanel || !app.isPublic || !app.domain) continue;

    if (app.asleep && state.panelHostPort != null) {
      // Sleeping/waking: route the domain to the panel container, which
      // serves the 503 wake page (and wakes the app) for foreign hosts.
      httpRouters[`pub-${app.name}`] = {
        entryPoints: ["websecure"],
        rule: `Host(\`${app.domain}\`)`,
        service: "ocd-panel",
        tls: publicTls(app.domain, state.zoneName),
      };
      needPanelService = true;
    } else if (!app.asleep && hasUpstreams) {
      // The public router proxies HTTP to the replicas even for
      // health_check=0 apps (same as the old public vhost), so make sure an
      // HTTP service exists for TCP apps too.
      if (!httpServices[svcName]) {
        httpServices[svcName] = { loadBalancer: httpLoadBalancer(app) };
      }
      // Public-only middleware chain, cheapest rejection first: the IP
      // allowlist and rate limit turn unwanted traffic away before basicAuth
      // spends bcrypt CPU verifying it (an unauthenticated flood must not
      // become a hashing DoS); compress and sec-headers only shape responses
      // that made it through. Internal routers skip all of this except auth —
      // app-to-app traffic is trusted.
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
      httpRouters[`pub-${app.name}`] = {
        entryPoints: ["websecure"],
        rule: `Host(\`${app.domain}\`)`,
        middlewares: [...pubMiddlewares, "sec-headers", "retry"],
        service: svcName,
        tls: publicTls(app.domain, state.zoneName),
      };
      needRetry = true;
      needSecHeaders = true;
    }
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

  if (needPanelService && state.panelHostPort != null) {
    httpServices["ocd-panel"] = {
      loadBalancer: {
        servers: [{ url: `http://127.0.0.1:${state.panelHostPort}` }],
      },
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
 * ocd.yml namespace (`app-*`, `svc-*`, `ocd-panel`, …) — the file provider
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
