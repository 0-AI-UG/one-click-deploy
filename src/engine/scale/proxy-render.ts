// ocd-proxy config render — the desired-state half of the VIP ingress stack.
// Consumes the same DB snapshot as the Traefik renderer (collectDesiredState)
// and renders every server's /etc/ocd-proxy/config.json from it. Pure apart
// from the persisted wake secret; proxy-provision.ts owns the unit/install
// script and proxy-manager.ts owns delivery.
//
// Types come from src/proxy/config.ts (type-only import — the compiled proxy
// binary never links against engine code).

import * as db from "../../shared/db.ts";
import type { ProxyApp, ProxyConfig } from "../../proxy/config.ts";
import type { DesiredState } from "./traefik-render.ts";
import { WAKER_HTTP_PORT } from "./traefik-constants.ts";

/**
 * VIP front-port policy (the user-visible ports the proxy DNATs to its single
 * per-VIP listener — see src/proxy/nat.ts), all TCP:
 *
 *   - `internal_port` — backcompat for URLs baked against the old
 *     `<app>.ocd.internal:20005`-style Traefik entrypoints.
 *   - `container_port` — the port the app itself listens on, so a config that
 *     names the container's own port keeps working against the VIP.
 *   - `80` for HTTP apps — the port-less `http://<app>.ocd.internal` form.
 *
 * Deduplicated (container_port may be 80 or equal internal_port) and sorted
 * so the rendered config is deterministic.
 */
export function frontPorts(app: {
  internalPort: number;
  containerPort: number;
  internalProtocol: "http" | "tcp";
}): number[] {
  // internalPort is legacy-compat only: containers deployed before the
  // Traefik internal-ingress teardown still have `:200xx` URLs baked into
  // their process env. Removable once the fleet's containers have all been
  // recreated with fresh baked env.
  const ports = new Set<number>([app.internalPort, app.containerPort]);
  if (app.internalProtocol === "http") ports.add(80);
  return [...ports].sort((a, b) => a - b);
}

/**
 * Render the fleet-wide ProxyConfig from a desired-state snapshot. Identical
 * on every server (the proxy is VIP-addressed, not server-addressed). Apps
 * without an allocated VIP are skipped — nothing to bind. Deterministic
 * output (sorted apps, sorted front ports, upstreams pre-sorted by
 * buildUpstreams) so content-hash convergence can skip no-op writes.
 */
export function renderProxyConfig(state: DesiredState): ProxyConfig {
  const apps: ProxyApp[] = state.apps
    .filter((app) => app.virtualIp !== "")
    .map((app) => ({
      appId: app.appId,
      name: app.name,
      vip: app.virtualIp,
      frontPorts: frontPorts(app),
      backends: app.upstreams,
      sleeping: app.asleep,
      // Password-protected apps: an L4 proxy cannot check HTTP basic-auth
      // credentials, so the proxy fail-closes these connections (destroys
      // them on accept) — otherwise the VIP would be an unauthenticated
      // bypass of the basicAuth Traefik enforces on the public router.
      ...(app.authHash ? { authProtected: true } : {}),
    }))
    // collectDesiredState already sorts by name; re-sort so hand-built
    // snapshots (tests, callers) render deterministically too.
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 1,
    // Wake calls go to the waker's :8896 listener — the only panel port
    // published on the private IP (the API port binds 127.0.0.1 only), and
    // the same port every server's Traefik already dials for sleeping apps.
    // Until the panel is on the private network there is nowhere to wake from
    // — the proxy then fails wake attempts loudly instead of hanging.
    wakeUrl: state.panelPrivateIpv4
      ? `http://${state.panelPrivateIpv4}:${WAKER_HTTP_PORT}/api/internal/wake`
      : null,
    wakeSecret: db.ensureProxyWakeSecret(),
    apps,
  };
}

/** The exact bytes shipped to /etc/ocd-proxy/config.json. */
export function renderProxyConfigJson(state: DesiredState): string {
  return JSON.stringify(renderProxyConfig(state), null, 2);
}

/**
 * One app's `/etc/hosts` line on one server (consumed by syncInternalHosts),
 * or null to emit nothing for this app. The app resolves to its VIP once the
 * server's ocd-proxy has been confirmed live at least once
 * (`wasProxyEverReady`) — a later converge failure keeps these last-known-good
 * lines, since the proxy almost certainly still runs with its previous
 * config. A never-proven proxy, or an app without a VIP, emits NOTHING: the
 * legacy `<server-private-ip>` fallback pointed at the server's Traefik
 * internal entrypoints, which the port-based ingress teardown removed — such
 * a line would route internal calls to a closed port.
 *
 * Auth-protected apps get no hosts line at all: the L4 proxy cannot verify
 * basic-auth credentials (it fail-closes those VIPs), so internal callers
 * must resolve the app's public DNS and go through Traefik, which enforces
 * the basicAuth middleware.
 */
export function appHostsLine(
  app: { name: string; virtual_ip: string; auth_password_hash?: string | null },
  _serverPrivateIpv4: string,
  proxyEverReady: boolean,
): string | null {
  if (app.auth_password_hash) return null;
  if (!proxyEverReady || !app.virtual_ip) return null;
  return `${app.virtual_ip} ${app.name}.ocd.internal`;
}
