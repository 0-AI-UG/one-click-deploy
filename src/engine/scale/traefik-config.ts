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
//   internal-http     — :8080 compat alias: `Host(<app>.ocd.internal)`
//                       routing, the pre-Traefik internal ingress surface.
//                       Kept indefinitely (cost ≈ zero).
//   int20000-int20199 — one entrypoint per app `internal_port`. HTTP apps get
//                       an HTTP router, health_check=0 apps a raw TCP router,
//                       so one address `<app>.ocd.internal:<internal_port>`
//                       works for both protocols.
//
// The 200-port block is fixed forever (it doubles as the fleet app cap), so
// the static config never changes after install — zero restarts in steady
// state. Dynamic state lives in /etc/traefik/dynamic/ocd.yml, re-rendered
// from the DB as a whole (desired-state, not incremental edits) and picked
// up by the file provider's watcher. The panel's own vhost lives in a
// separate panel.yml owned by bootstrap (see deployTraefikPanelSite) — app
// syncs never disturb panel WebSocket/terminal sessions.
//
// All emitted "YAML" is JSON (JSON is valid YAML) — no serializer dependency.

import * as db from "../../shared/db.ts";
import { authProxyPort } from "../../shared/remote/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";

/** Pinned Traefik release installed on every server. v3.5+ is required for
 *  TCP server health checks (`tcp.services.*.loadBalancer.healthCheck`),
 *  which replace Caddy's passive checks for health_check=0 apps. */
export const TRAEFIK_VERSION = "3.7.7";

/** Compat alias port for `Host(<app>.ocd.internal)` internal HTTP routing. */
export const INTERNAL_HTTP_COMPAT_PORT = 8080;

export const TRAEFIK_STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
export const TRAEFIK_DYNAMIC_DIR = "/etc/traefik/dynamic";
export const TRAEFIK_DYNAMIC_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/ocd.yml`;
export const TRAEFIK_PANEL_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/panel.yml`;
export const TRAEFIK_ACME_PATH = "/etc/traefik/acme.json";

function entrypointName(internalPort: number): string {
  return `int${internalPort}`;
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

/**
 * The static config installed at /etc/traefik/traefik.yml — identical on
 * every server in the fleet, written once at install time and never touched
 * again (dynamic state goes through the file provider). The ACME resolver is
 * inert on workers: no router references it there.
 */
export function traefikStaticConfig(): string {
  const entryPoints: Record<string, { address: string }> = {
    web: { address: ":80" },
    websecure: { address: ":443" },
    "internal-http": { address: `:${INTERNAL_HTTP_COMPAT_PORT}` },
  };
  for (
    let port = db.INTERNAL_PORT_BASE;
    port < db.INTERNAL_PORT_BASE + db.INTERNAL_PORT_COUNT;
    port++
  ) {
    entryPoints[entrypointName(port)] = { address: `:${port}` };
  }
  const config = {
    entryPoints,
    providers: {
      file: { directory: TRAEFIK_DYNAMIC_DIR, watch: true },
    },
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          storage: TRAEFIK_ACME_PATH,
          httpChallenge: { entryPoint: "web" },
        },
      },
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
 * provisioning) and ensureTraefikInstalled (reconciler backfill over SSH):
 * download the static binary (arch-detected), write the static config, create
 * the dynamic dir, lock down acme.json, install the systemd unit, enable now.
 */
export function traefikInstallScript(): string {
  return `set -e
TRAEFIK_ARCH=$(uname -m)
case "$TRAEFIK_ARCH" in
  x86_64) TRAEFIK_ARCH=amd64 ;;
  aarch64) TRAEFIK_ARCH=arm64 ;;
esac
if ! /usr/local/bin/traefik version >/dev/null 2>&1; then
  curl -fsSL -o /tmp/traefik.tar.gz "https://github.com/traefik/traefik/releases/download/v${TRAEFIK_VERSION}/traefik_v${TRAEFIK_VERSION}_linux_\${TRAEFIK_ARCH}.tar.gz"
  tar -xzf /tmp/traefik.tar.gz -C /tmp traefik
  install -m 755 /tmp/traefik /usr/local/bin/traefik
  rm -f /tmp/traefik.tar.gz /tmp/traefik
fi
mkdir -p ${TRAEFIK_DYNAMIC_DIR}
cat > ${TRAEFIK_STATIC_CONFIG_PATH} <<'OCD_TRAEFIK_STATIC'
${traefikStaticConfig()}
OCD_TRAEFIK_STATIC
touch ${TRAEFIK_ACME_PATH}
chmod 600 ${TRAEFIK_ACME_PATH}
cat > /etc/systemd/system/ocd-traefik.service <<'OCD_TRAEFIK_UNIT'
${traefikSystemdUnit()}
OCD_TRAEFIK_UNIT
systemctl daemon-reload
systemctl enable --now ocd-traefik
`;
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
  /** `<private-ip>:<port>` dial strings, sorted. Auth-protected apps point
   *  at the auth proxy's port instead of the replica's host port. */
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
function buildUpstreams(appId: number, authPassword: string): string[] {
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
    const destPort = authPassword
      ? authProxyPort(replica.host_port)
      : replica.host_port;
    ups.push(`${server.private_ipv4}:${destPort}`);
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
      upstreams: buildUpstreams(app.id, app.auth_password),
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
  return { apps, services, panelHostPort: panel?.host_port ?? null };
}

// --- Dynamic config render -----------------------------------------------------

type TlsConfig = Record<string, unknown>;

/** nip.io domains can't get Let's Encrypt certs — `tls: {}` serves Traefik's
 *  built-in default self-signed certificate instead of a handshake error. */
function publicTls(domain: string): TlsConfig {
  return domain.endsWith(".nip.io") ? {} : { certResolver: "letsencrypt" };
}

/**
 * Render /etc/traefik/dynamic/ocd.yml from a desired-state snapshot.
 *
 * Every server gets the internal routers (per-app entrypoint + :8080 compat);
 * only the panel (`isPanel`) additionally gets public routers: app domains,
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

  let needRetry = false;
  let needSecHeaders = false;
  let needSvcHeaders = false;
  let needPanelService = false;

  for (const app of state.apps) {
    const svcName = `app-${app.name}`;
    const hasUpstreams = app.upstreams.length > 0;

    if (hasUpstreams && app.httpProbe) {
      httpServices[svcName] = {
        loadBalancer: {
          servers: app.upstreams.map((u) => ({ url: `http://${u}` })),
        },
      };
      // Internal router on every server: the app's own entrypoint.
      httpRouters[`int-${app.name}`] = {
        entryPoints: [entrypointName(app.internalPort)],
        rule: "PathPrefix(`/`)",
        middlewares: ["retry"],
        service: svcName,
      };
      // Compat alias: Host(<app>.ocd.internal) on :8080.
      httpRouters[`compat-${app.name}`] = {
        entryPoints: ["internal-http"],
        rule: `Host(\`${internalHost(app.name)}\`)`,
        middlewares: ["retry"],
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

    // Public route: panel only, public apps with a domain.
    if (!opts.isPanel || !app.isPublic || !app.domain) continue;

    if (app.asleep && state.panelHostPort != null) {
      // Sleeping/waking: route the domain to the panel container, which
      // serves the 503 wake page (and wakes the app) for foreign hosts.
      httpRouters[`pub-${app.name}`] = {
        entryPoints: ["websecure"],
        rule: `Host(\`${app.domain}\`)`,
        service: "ocd-panel",
        tls: publicTls(app.domain),
      };
      needPanelService = true;
    } else if (!app.asleep && hasUpstreams) {
      // The public router proxies HTTP to the replicas even for
      // health_check=0 apps (same as the old public vhost), so make sure an
      // HTTP service exists for TCP apps too.
      if (!httpServices[svcName]) {
        httpServices[svcName] = {
          loadBalancer: {
            servers: app.upstreams.map((u) => ({ url: `http://${u}` })),
          },
        };
      }
      httpRouters[`pub-${app.name}`] = {
        entryPoints: ["websecure"],
        rule: `Host(\`${app.domain}\`)`,
        middlewares: ["sec-headers", "retry"],
        service: svcName,
        tls: publicTls(app.domain),
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
        tls: publicTls(svc.domain),
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
  internalTls: boolean,
): string {
  const config = {
    http: {
      routers: {
        panel: {
          entryPoints: ["websecure"],
          rule: `Host(\`${domain}\`)`,
          service: "panel",
          tls: internalTls ? {} : { certResolver: "letsencrypt" },
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
