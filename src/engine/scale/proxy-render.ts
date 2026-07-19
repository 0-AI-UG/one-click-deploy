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

/**
 * VIP listener policy, all TCP:
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
export function listenerPorts(app: {
  internalPort: number;
  containerPort: number;
  internalProtocol: "http" | "tcp";
}): number[] {
  const ports = new Set<number>([app.internalPort, app.containerPort]);
  if (app.internalProtocol === "http") ports.add(80);
  return [...ports].sort((a, b) => a - b);
}

/**
 * Render the fleet-wide ProxyConfig from a desired-state snapshot. Identical
 * on every server (the proxy is VIP-addressed, not server-addressed). Apps
 * without an allocated VIP are skipped — nothing to bind. Deterministic
 * output (sorted apps, sorted listener ports, upstreams pre-sorted by
 * buildUpstreams) so content-hash convergence can skip no-op writes.
 */
export function renderProxyConfig(state: DesiredState): ProxyConfig {
  const apps: ProxyApp[] = state.apps
    .filter((app) => app.virtualIp !== "")
    .map((app) => ({
      appId: app.appId,
      name: app.name,
      vip: app.virtualIp,
      listeners: listenerPorts(app).map((port) => ({ port, protocol: "tcp" as const })),
      backends: app.upstreams,
      sleeping: app.asleep,
    }))
    // collectDesiredState already sorts by name; re-sort so hand-built
    // snapshots (tests, callers) render deterministically too.
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 1,
    // The panel runs in a container: from other servers it is reachable only
    // at its *published* host port on the private IP (panelHostPort), not the
    // in-container listen port. Until both are known there is nowhere to wake
    // from — the proxy then fails wake attempts loudly instead of hanging.
    wakeUrl:
      state.panelPrivateIpv4 && state.panelHostPort
        ? `http://${state.panelPrivateIpv4}:${state.panelHostPort}/api/internal/wake`
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
 * One app's `/etc/hosts` line on one server (consumed by syncInternalHosts).
 * The app resolves to its VIP only when it has one AND the server's ocd-proxy
 * has been confirmed live (`proxyReady`, see isProxyReady) — otherwise it
 * keeps the safe local-Traefik private-IP line, so DNS never points at a VIP
 * no proxy is terminating.
 */
export function appHostsLine(
  app: { name: string; virtual_ip: string },
  serverPrivateIpv4: string,
  proxyReady: boolean,
): string {
  const ip = proxyReady && app.virtual_ip ? app.virtual_ip : serverPrivateIpv4;
  return `${ip} ${app.name}.ocd.internal`;
}
