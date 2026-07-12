// Traefik ingress manager — owns every server's /etc/traefik/dynamic/ocd.yml.
// Renders the fleet's desired routing state from the DB (traefik-config.ts)
// and ships it to each server over SSH with an atomic tmp+mv write; Traefik's
// file provider hot-reloads it with zero restarts and without dropping
// established connections on unchanged routers.
//
// The whole file is a desired-state render, so the public API is intentionally
// coarse: every sync/remove entrypoint re-renders everything. The per-app /
// per-service arguments exist so callsites read naturally and stay a
// mechanical rename from the old per-route manager.

import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import {
  collectDesiredState,
  renderDynamicConfig,
  renderPanelConfig,
  traefikInstallScript,
  TRAEFIK_DYNAMIC_CONFIG_PATH,
  TRAEFIK_PANEL_CONFIG_PATH,
} from "./traefik-config.ts";

export { internalAppUrl, TRAEFIK_VERSION } from "./traefik-config.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [traefik-mgr:${context}]`, ...args);
}

export type ServerAccess = {
  name: string;
  ipv4: string;
  privateIpv4: string;
  hostKey: string | undefined;
};

function getPanelAccess(): ServerAccess | null {
  const panel = db.getPanel();
  if (!panel) return null;
  const panelServer = db.getServer(panel.server_id);
  if (!panelServer || !panelServer.ipv4) return null;
  return {
    name: panelServer.name,
    ipv4: panelServer.ipv4,
    privateIpv4: panelServer.private_ipv4 || "",
    hostKey: panelServer.ssh_host_key || undefined,
  };
}

/**
 * Every server that runs an ocd-traefik instance. A server without a private
 * IP can't be an upstream target, but its local Traefik still serves the
 * internal entrypoints for callers on that host. We require `ipv4` only.
 */
function getAllServerAccess(): ServerAccess[] {
  return db
    .getServers()
    .filter((s) => s.ipv4)
    .map((s) => ({
      name: s.name,
      ipv4: s.ipv4,
      privateIpv4: s.private_ipv4 || "",
      hostKey: s.ssh_host_key || undefined,
    }));
}

/**
 * Atomic remote config write: tmp file + `mv -f` so the file provider's
 * watcher never observes a half-written config.
 */
async function writeRemoteConfigAtomic(
  server: ServerAccess,
  remotePath: string,
  content: string,
): Promise<void> {
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  const tmpPath = `${dir}/.${remotePath.substring(remotePath.lastIndexOf("/") + 1)}.tmp`;
  const escaped = content.replace(/'/g, "'\\''");
  const result = await sshExec(
    server.ipv4,
    `mkdir -p ${dir} && printf '%s\\n' '${escaped}' > ${tmpPath} && chmod 644 ${tmpPath} && mv -f ${tmpPath} ${remotePath}`,
    server.hostKey,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write ${remotePath} on ${server.name}: ${result.stderr || result.stdout}`,
    );
  }
}

// Content-hash cache of the last dynamic config successfully written per
// server (keyed by ipv4). Purely an SSH-traffic optimization — the panel's
// own vhost lives in a separate, never-touched panel.yml, so unlike the old
// per-route cache nothing correctness-critical depends on skipping writes.
const lastConfigHashByServer = new Map<string, string>();

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

/**
 * Render and (if changed) write this server's /etc/traefik/dynamic/ocd.yml.
 * `state` lets syncAllTraefik share one DB snapshot across the fleet.
 */
export async function syncServerTraefik(
  server: ServerAccess,
  opts: { state?: ReturnType<typeof collectDesiredState>; force?: boolean } = {},
): Promise<void> {
  const state = opts.state ?? collectDesiredState();
  const panel = getPanelAccess();
  const isPanel = panel !== null && panel.ipv4 === server.ipv4;
  const content = renderDynamicConfig(state, { isPanel });
  const hash = contentHash(content);
  if (!opts.force && lastConfigHashByServer.get(server.ipv4) === hash) return;
  await writeRemoteConfigAtomic(server, TRAEFIK_DYNAMIC_CONFIG_PATH, content);
  lastConfigHashByServer.set(server.ipv4, hash);
  log("sync", `wrote ocd.yml on ${server.name}${isPanel ? " (panel)" : ""}`);
}

/**
 * Desired-state sync of every server's dynamic config. Partial failures are
 * tolerated — the reconciler retries lagging servers on the next tick.
 */
export async function syncAllTraefik(force = false): Promise<void> {
  const state = collectDesiredState();
  const servers = getAllServerAccess();
  await Promise.all(
    servers.map(async (srv) => {
      try {
        await syncServerTraefik(srv, { state, force });
      } catch (err) {
        log("sync", `dynamic config sync failed on ${srv.name}: ${err}`);
      }
    }),
  );
}

/**
 * Re-render ingress after an app lifecycle event. The appId argument is
 * advisory — the desired-state render always covers the whole fleet.
 * Idempotent; safe to call on every lifecycle event.
 */
export async function syncAppIngress(appId: number, force = false): Promise<void> {
  const app = db.getApp(appId);
  if (app) log("sync", `app ${appId} (${app.name}) domain=${app.domain}`);
  await syncAllTraefik(force);
}

/**
 * Drop an app's routes. With a desired-state render this is just a re-sync:
 * once the app/replica rows are gone (or unservable) its routers disappear
 * from the rendered file. Callers that delete rows *after* this call are
 * converged by the reconciler's periodic sync one tick later.
 */
export async function removeAppIngress(
  appName: string,
  _appDomain: string,
  _appId?: number,
): Promise<void> {
  log("remove", `app ${appName}: re-rendering ingress`);
  await syncAllTraefik();
}

// --- HTTP services -----------------------------------------------------------

type ServiceIngressOptions = {
  serviceName: string;
  domain: string;
  serverPrivateIpv4: string;
  hostPort: number;
};

export function getPanelIngressIpv4(): string | null {
  const panel = getPanelAccess();
  return panel?.ipv4 || null;
}

export async function syncServiceIngress(opts: ServiceIngressOptions): Promise<void> {
  const panel = getPanelAccess();
  if (!panel) {
    throw new Error(
      "No panel server is registered; HTTP services need a panel to route ingress through. Deploy the panel first.",
    );
  }
  if (!opts.serverPrivateIpv4) {
    throw new Error(
      "Service server has no private IP — HTTP services require the shared private network. Wait for the network reconciler to attach the server and retry.",
    );
  }
  log(
    "svc-sync",
    `service ${opts.serviceName} → ${opts.domain} (upstream ${opts.serverPrivateIpv4}:${opts.hostPort})`,
  );
  await syncAllTraefik();
}

export async function removeServiceIngress(
  serviceName: string,
  _domain?: string,
): Promise<void> {
  log("svc-remove", `service ${serviceName}: re-rendering ingress`);
  await syncAllTraefik();
}

// --- Install / bootstrap -------------------------------------------------------

// Servers already verified to run ocd-traefik — skip the per-tick SSH probe.
const traefikInstalledCache = new Set<string>();

/**
 * Idempotent Traefik install over SSH: check the pinned binary + unit, and
 * when missing run the shared install script (download pinned release, static
 * config, acme.json perms, systemd unit, enable --now). Fresh servers get all
 * of this from cloud-init; this is the reconciler's backfill for servers
 * provisioned before the Traefik migration or with a failed cloud-init.
 */
export async function ensureTraefikInstalled(server: ServerAccess): Promise<void> {
  if (traefikInstalledCache.has(server.ipv4)) return;
  const check = await sshExec(
    server.ipv4,
    `/usr/local/bin/traefik version >/dev/null 2>&1 && systemctl is-active ocd-traefik >/dev/null 2>&1 && echo ok || echo missing`,
    server.hostKey,
  );
  if (check.stdout.trim() === "ok") {
    traefikInstalledCache.add(server.ipv4);
    return;
  }
  log("install", `installing Traefik on ${server.name} (${server.ipv4})`);
  const result = await sshExec(server.ipv4, traefikInstallScript(), server.hostKey);
  if (result.exitCode !== 0) {
    throw new Error(
      `Traefik install failed on ${server.name}: ${result.stderr || result.stdout}`,
    );
  }
  traefikInstalledCache.add(server.ipv4);
  log("install", `Traefik installed and running on ${server.name}`);
}

/**
 * Reconciler entrypoint: make sure every ready server runs ocd-traefik, then
 * drift-repair every server's dynamic config. This is also what populates
 * dynamic configs right after the manual Caddy→Traefik cutover.
 */
export async function reconcileTraefik(): Promise<void> {
  for (const server of db.getServers()) {
    if (server.status !== "ready" || !server.ipv4) continue;
    try {
      await ensureTraefikInstalled({
        name: server.name,
        ipv4: server.ipv4,
        privateIpv4: server.private_ipv4 || "",
        hostKey: server.ssh_host_key || undefined,
      });
    } catch (err) {
      log("install", `ensure failed on ${server.name}: ${err}`);
    }
  }
  await syncAllTraefik();
}

/**
 * Write the panel's own vhost to /etc/traefik/dynamic/panel.yml. Called from
 * panel bootstrap (and nowhere else) — the engine's ocd.yml renderer never
 * touches this file, so panel WebSocket/terminal sessions survive app syncs.
 * Runs against an explicit server because bootstrap's DB has no panel row
 * relationship to lean on yet.
 */
export async function deployTraefikPanelSite(
  serverIp: string,
  domain: string,
  hostPort: number,
  internalTls: boolean = false,
  hostKey?: string,
): Promise<void> {
  log("panel", `Deploying panel vhost: domain=${domain} port=${hostPort} internalTls=${internalTls}`);
  const server: ServerAccess = {
    name: serverIp,
    ipv4: serverIp,
    privateIpv4: "",
    hostKey,
  };
  await writeRemoteConfigAtomic(
    server,
    TRAEFIK_PANEL_CONFIG_PATH,
    renderPanelConfig(domain, hostPort, internalTls),
  );
  log("panel", "Panel vhost written (Traefik hot-reloads via the file provider)");
}
