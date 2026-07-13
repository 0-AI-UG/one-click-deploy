// Traefik provisioning — the bash/static-config half of the ingress stack.
// Generates the identical-on-every-server static config, the systemd unit, the
// idempotent install script (shared by cloud-init and the reconciler's SSH
// backfill), and the panel-only env file. traefik-manager.ts owns delivery
// (SSH writes, install, caching); traefik-render.ts owns the dynamic config.
//
// One Traefik instance runs on *every* server (systemd unit `ocd-traefik`)
// with an identical static config:
//
//   web / websecure   — :80/:443 public ingress. Only the panel server ever
//                       gets routers on these (public app domains, managed
//                       services, ACME); on workers they sit idle.
//   int20000-int20199 — one entrypoint per app `internal_port`. Apps with
//                       internal_protocol='http' (or any auth-protected app)
//                       get an HTTP router; internal_protocol='tcp' apps a raw
//                       TCP router, so one address
//                       `<app>.ocd.internal:<internal_port>` works for both
//                       protocols. The routing protocol is an explicit app
//                       field, independent of the health_check probe flag.
//   pub30000-pub30049 / pubu30050-pubu30099 — public raw TCP/UDP pool
//                       (apps.public_port). Routed on the panel only:
//                       `<panel-ip>:<port>` forwards raw to the app's
//                       replicas over the private network.
//
// The 200-port block is fixed forever (it doubles as the fleet app cap).
// Static config rarely changes; when it does, the reconciler converges every
// server (rewrite + service restart) within one tick — steady-state ticks
// never restart.
//
// All emitted "YAML" is JSON (JSON is valid YAML) — no serializer dependency.

import * as db from "../../shared/db.ts";
import {
  TRAEFIK_VERSION,
  TRAEFIK_METRICS_PORT,
  entrypointName,
  publicPortEntrypoint,
  TRAEFIK_STATIC_CONFIG_PATH,
  TRAEFIK_ACCESS_LOG_PATH,
  TRAEFIK_LOGROTATE_PATH,
  TRAEFIK_UNIT_PATH,
  TRAEFIK_DYNAMIC_DIR,
  TRAEFIK_ACME_PATH,
  TRAEFIK_ACME_DNS_PATH,
  TRAEFIK_ENV_PATH,
} from "./traefik-constants.ts";

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
