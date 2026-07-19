// Traefik ingress manager — owns every server's /etc/traefik/dynamic/ocd.yml.
// Renders the fleet's desired routing state from the DB (traefik-render.ts)
// and ships it to each server over SSH with an atomic tmp+mv write; Traefik's
// file provider hot-reloads it with zero restarts and without dropping
// established connections on unchanged routers.
//
// The whole file is a desired-state render, so the public API is intentionally
// coarse: syncAllTraefik re-renders and ships every server; syncAppIngress
// wraps it with per-app error semantics. There are no per-route add/remove
// calls — dropping an app is just a re-sync once its rows are gone.

import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { hetznerApiToken } from "../hetzner/api.ts";
import {
  collectDesiredState,
  renderDynamicConfig,
  renderPanelConfig,
} from "./traefik-render.ts";
import {
  traefikEnvFile,
  traefikInstallScript,
  traefikStaticConfig,
  traefikSystemdUnit,
} from "./traefik-provision.ts";
import {
  TRAEFIK_DYNAMIC_CONFIG_PATH,
  TRAEFIK_ENV_PATH,
  TRAEFIK_PANEL_CONFIG_PATH,
  TRAEFIK_STATIC_CONFIG_PATH,
  TRAEFIK_UNIT_PATH,
  TRAEFIK_VERSION,
} from "./traefik-constants.ts";

export { TRAEFIK_VERSION } from "./traefik-constants.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [traefik-mgr:${context}]`, ...args);
}

export type ServerAccess = {
  name: string;
  ipv4: string;
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
    hostKey: panelServer.ssh_host_key || undefined,
  };
}

/**
 * Every server that runs an ocd-traefik instance. A server without a private
 * IP can't be an upstream target, but its local Traefik still serves the
 * internal entrypoints for callers on that host. Only `ready` servers are
 * addressed — SSHing a `creating`/`provisioning` box is a guaranteed failure
 * (cloud-init installs Traefik and the first post-ready sync covers it), and
 * a destroying one is gone.
 */
function getAllServerAccess(): ServerAccess[] {
  return db
    .getServers()
    .filter((s) => s.ipv4 && s.status === "ready")
    .map((s) => ({
      name: s.name,
      ipv4: s.ipv4,
      hostKey: s.ssh_host_key || undefined,
    }));
}

// Per-server write serialization. The reconciler tick and op-driven syncs run
// concurrently in one engine process; two overlapping tmp+mv sequences on the
// same host could publish a half-written file under the other writer's name.
// The unique tmp suffix already makes tmp collisions impossible — the lock
// additionally orders same-file writes so the outcome is always some caller's
// complete config, never an interleaving. (Two renders from different DB
// snapshots can still land older-last; the reconciler's per-tick remote-hash
// convergence bounds that staleness to one tick.)
const serverLocks = new Map<string, Promise<unknown>>();

function withServerLock<T>(ipv4: string, fn: () => Promise<T>): Promise<T> {
  const prev = serverLocks.get(ipv4) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  serverLocks.set(
    ipv4,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Atomic remote config write: unique tmp file + same-dir `mv -f` so the file
 * provider's watcher never observes a half-written config, serialized
 * per-server via withServerLock. The tmp file is removed on failure.
 */
async function writeRemoteConfigAtomic(
  server: ServerAccess,
  remotePath: string,
  content: string,
  mode = "644",
): Promise<void> {
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  const base = remotePath.substring(remotePath.lastIndexOf("/") + 1);
  const tmpPath = `${dir}/.${base}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  const escaped = content.replace(/'/g, "'\\''");
  await withServerLock(server.ipv4, async () => {
    const result = await sshExec(
      server.ipv4,
      `mkdir -p ${dir} && printf '%s\\n' '${escaped}' > ${tmpPath} && chmod ${mode} ${tmpPath} && mv -f ${tmpPath} ${remotePath} || { rm -f ${tmpPath}; exit 1; }`,
      server.hostKey,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write ${remotePath} on ${server.name}: ${result.stderr || result.stdout}`,
      );
    }
  });
}

// Content-hash cache of the last config file successfully written, keyed by
// server ipv4 → remote path → hash. Covers both ocd.yml and the separately
// owned panel.yml. Purely an SSH-traffic optimization: convergeServerTraefik
// trusts the remote probe, not this cache, so a stale/missing entry only ever
// costs one extra write.
const configHashCache = new Map<string, Map<string, string>>();

function getCachedHash(ipv4: string, path: string): string | undefined {
  return configHashCache.get(ipv4)?.get(path);
}

function setCachedHash(ipv4: string, path: string, hash: string): void {
  let byPath = configHashCache.get(ipv4);
  if (!byPath) {
    byPath = new Map();
    configHashCache.set(ipv4, byPath);
  }
  byPath.set(path, hash);
}

function clearCachedHash(ipv4: string, path: string): void {
  configHashCache.get(ipv4)?.delete(path);
}

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
  if (!opts.force && getCachedHash(server.ipv4, TRAEFIK_DYNAMIC_CONFIG_PATH) === hash) return;
  await writeRemoteConfigAtomic(server, TRAEFIK_DYNAMIC_CONFIG_PATH, content);
  setCachedHash(server.ipv4, TRAEFIK_DYNAMIC_CONFIG_PATH, hash);
  log("sync", `wrote ocd.yml on ${server.name}${isPanel ? " (panel)" : ""}`);
}

/**
 * Desired-state sync of every server's dynamic config. Partial failures are
 * tolerated — the reconciler retries lagging servers on the next tick — but
 * reported back so callers with a stake in a specific server can fail loudly.
 */
export async function syncAllTraefik(force = false): Promise<{ failed: string[] }> {
  const state = collectDesiredState();
  const servers = getAllServerAccess();
  const failed: string[] = [];
  await Promise.all(
    servers.map(async (srv) => {
      try {
        await syncServerTraefik(srv, { state, force });
      } catch (err) {
        failed.push(srv.name);
        log("sync", `dynamic config sync failed on ${srv.name}: ${err}`);
      }
    }),
  );
  return { failed };
}

/**
 * Re-render ingress after an app lifecycle event. The appId argument is
 * advisory for the render (which always covers the whole fleet) but decides
 * error semantics: a failed write on a server that carries this app's routes
 * (the panel, or a server hosting one of its replicas) throws so the calling
 * op fails honestly instead of logging success over stale routes. Failures on
 * unrelated servers stay tolerated — the reconciler heals them next tick.
 */
export async function syncAppIngress(appId: number, force = false): Promise<void> {
  const app = db.getApp(appId);
  if (app) log("sync", `app ${appId} (${app.name}) domain=${app.domain}`);
  const { failed } = await syncAllTraefik(force);
  if (failed.length === 0 || !app) return;
  const critical = new Set<string>();
  const panel = getPanelAccess();
  if (panel) critical.add(panel.name);
  for (const replica of db.getReplicas(app.id)) {
    const server = db.getServer(replica.server_id);
    if (server) critical.add(server.name);
  }
  const blocking = failed.filter((name) => critical.has(name));
  if (blocking.length > 0) {
    throw new Error(
      `Ingress config write failed on ${blocking.join(", ")} — ${app.name}'s routes may be stale (the reconciler retries within 30s)`,
    );
  }
}

export function getPanelIngressIpv4(): string | null {
  const panel = getPanelAccess();
  return panel?.ipv4 || null;
}

// --- Install / reconcile convergence -----------------------------------------

function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** sha256 of a config file as it exists on disk remotely: every writer (the
 *  install script's heredocs, writeRemoteConfigAtomic's printf) appends one
 *  trailing newline to the rendered content. */
function remoteFileSha(content: string): string {
  return sha256(content + "\n");
}

type RemoteProbe = {
  version: string;
  active: string;
  staticSha: string;
  unitSha: string;
  dynamicSha: string;
  panelSha: string;
  envSha: string;
};

/** One SSH round-trip that reports everything convergence needs: binary
 *  version, unit state, and the on-disk hash of each managed config file. */
async function probeServerTraefik(server: ServerAccess): Promise<RemoteProbe> {
  const cmd = [
    `V=$(/usr/local/bin/traefik version 2>/dev/null | awk '/Version:/{print $2; exit}')`,
    `A=$(systemctl is-active ocd-traefik 2>/dev/null || true)`,
    `sha() { sha256sum "$1" 2>/dev/null | cut -d" " -f1; }`,
    `echo "$V|$A|$(sha ${TRAEFIK_STATIC_CONFIG_PATH})|$(sha ${TRAEFIK_UNIT_PATH})|$(sha ${TRAEFIK_DYNAMIC_CONFIG_PATH})|$(sha ${TRAEFIK_PANEL_CONFIG_PATH})|$(sha ${TRAEFIK_ENV_PATH})"`,
  ].join("\n");
  const result = await sshExec(server.ipv4, cmd, server.hostKey);
  if (result.exitCode !== 0) {
    throw new Error(`probe failed on ${server.name}: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const [version = "", active = "", staticSha = "", unitSha = "", dynamicSha = "", panelSha = "", envSha = ""] =
    line.split("|");
  return { version, active, staticSha, unitSha, dynamicSha, panelSha, envSha };
}

/** Desired content of the panel server's ${TRAEFIK_ENV_PATH}: the Hetzner
 *  API token (reused as HETZNER_API_KEY — DNS is part of the unified Cloud
 *  API) for wildcard DNS-01 issuance. "" when no DNS zone is configured or
 *  no token exists — the wildcard resolver is absent/inert then. */
async function expectedPanelEnv(zoneName: string): Promise<string> {
  if (!zoneName) return "";
  const token = await hetznerApiToken();
  return token ? traefikEnvFile(token) : "";
}

/**
 * Idempotent Traefik install over SSH: run the shared install script
 * (download the pinned release if the installed version differs, static
 * config, acme.json perms, systemd unit, restart). Fresh servers get all of
 * this from cloud-init; this is the reconciler's backfill for servers with a
 * failed cloud-init or an outdated binary.
 */
async function installTraefik(server: ServerAccess): Promise<void> {
  log("install", `installing Traefik ${TRAEFIK_VERSION} on ${server.name} (${server.ipv4})`);
  const result = await sshExec(server.ipv4, traefikInstallScript(), server.hostKey);
  if (result.exitCode !== 0) {
    throw new Error(
      `Traefik install failed on ${server.name}: ${result.stderr || result.stdout}`,
    );
  }
  log("install", `Traefik installed and running on ${server.name}`);
}

/**
 * Converge one remote config file to `desiredContent`, judged solely by the
 * probe's on-disk sha (never the in-memory cache). Writes with `mode` and runs
 * `onChange` only when it actually rewrote; returns whether it did. The single
 * "compare remote sha → rewrite → maybe react" primitive behind the env file,
 * static config, and systemd unit convergence.
 */
async function convergeRemoteFile(
  server: ServerAccess,
  path: string,
  desiredContent: string,
  probedSha: string,
  opts: { mode?: string; onChange?: () => void | Promise<void> } = {},
): Promise<boolean> {
  if (probedSha === remoteFileSha(desiredContent)) return false;
  await writeRemoteConfigAtomic(server, path, desiredContent, opts.mode ?? "644");
  await opts.onChange?.();
  return true;
}

/** Restart ocd-traefik on a server, throwing on failure. `daemonReload` picks
 *  up unit-file changes; a pure env-file change only needs the plain restart. */
async function restartTraefik(server: ServerAccess, daemonReload: boolean): Promise<void> {
  const cmd = daemonReload
    ? "systemctl daemon-reload && systemctl restart ocd-traefik"
    : "systemctl restart ocd-traefik";
  const restart = await sshExec(server.ipv4, cmd, server.hostKey);
  if (restart.exitCode !== 0) {
    throw new Error(
      `ocd-traefik restart failed on ${server.name}: ${restart.stderr || restart.stdout}`,
    );
  }
}

/**
 * Converge one server onto the desired Traefik state, trusting only the
 * remote probe — never the in-memory hash caches. This is what makes the
 * drift-repair guarantee real: a wiped /etc/traefik/dynamic, a hand-edited
 * config, or a server rebuilt at the same IP heals within one reconciler
 * tick even though the caches still remember the old writes. Static config /
 * unit drift triggers a rewrite + service restart (the only restart path in
 * steady state); an outdated or missing binary re-runs the install script.
 */
export async function convergeServerTraefik(
  server: ServerAccess,
  state: ReturnType<typeof collectDesiredState>,
  expected: { panelEnv: string },
): Promise<void> {
  const probe = await probeServerTraefik(server);
  const panel = getPanelAccess();
  const isPanel = panel !== null && panel.ipv4 === server.ipv4;

  // The ACME env file (HETZNER_API_KEY for the letsencrypt-dns resolver) is
  // converged on the panel server ONLY — the sole server with public routers
  // and ACME activity; workers' resolver config is inert without it and their
  // unit tolerates the missing file (`EnvironmentFile=-`). systemd reads the
  // file at service start, so a change needs a restart: write it before the
  // install/restart branches below so one restart picks everything up.
  let envDrift = false;
  if (isPanel && expected.panelEnv) {
    envDrift = await convergeRemoteFile(server, TRAEFIK_ENV_PATH, expected.panelEnv, probe.envSha, {
      mode: "600",
      onChange: () => log("reconcile", `${server.name}: ACME env file drift → rewrite`),
    });
  }

  if (probe.version !== TRAEFIK_VERSION || probe.active !== "active") {
    log(
      "reconcile",
      `${server.name}: traefik=${probe.version || "missing"} unit=${probe.active || "unknown"} → install`,
    );
    await installTraefik(server);
  } else {
    const staticChanged = await convergeRemoteFile(
      server, TRAEFIK_STATIC_CONFIG_PATH, traefikStaticConfig(), probe.staticSha,
    );
    const unitChanged = await convergeRemoteFile(
      server, TRAEFIK_UNIT_PATH, traefikSystemdUnit(), probe.unitSha,
    );
    if (staticChanged || unitChanged) {
      log("reconcile", `${server.name}: static config/unit drift → rewrite + restart`);
      await restartTraefik(server, true);
    } else if (envDrift) {
      await restartTraefik(server, false);
    }
  }

  // ocd.yml has its own writer (syncServerTraefik) and shares the content-hash
  // cache; converge it against the probe and reseed the cache either way.
  const expectedDynamic = renderDynamicConfig(state, { isPanel });
  if (probe.dynamicSha !== remoteFileSha(expectedDynamic)) {
    clearCachedHash(server.ipv4, TRAEFIK_DYNAMIC_CONFIG_PATH);
    await syncServerTraefik(server, { state, force: true });
  } else {
    // Seed the cache so op-driven syncs between ticks can keep skipping.
    setCachedHash(server.ipv4, TRAEFIK_DYNAMIC_CONFIG_PATH, contentHash(expectedDynamic));
  }

  if (isPanel) {
    const panelRow = db.getPanel();
    if (panelRow?.domain && panelRow.host_port) {
      const expectedPanel = renderPanelConfig(
        panelRow.domain,
        panelRow.host_port,
        state.zoneName,
      );
      if (probe.panelSha !== remoteFileSha(expectedPanel)) {
        clearCachedHash(server.ipv4, TRAEFIK_PANEL_CONFIG_PATH);
      }
    }
    await reconcilePanelSite();
  }
}

/**
 * Reconciler entrypoint: probe every ready server in parallel and converge
 * binary, static config, systemd unit, dynamic config, and the panel's own
 * vhost onto desired state. Also rolls out static config changes (e.g. a
 * bumped TRAEFIK_VERSION or new ACME email) to the whole fleet.
 */
export async function reconcileTraefik(): Promise<void> {
  const state = collectDesiredState();
  const expected = {
    // "" (no zone, or no token) means the env file is left unmanaged — a
    // stale file on a former panel is harmless and never restart-looped.
    panelEnv: await expectedPanelEnv(state.zoneName),
  };
  await Promise.all(
    getAllServerAccess().map(async (server) => {
      try {
        await convergeServerTraefik(server, state, expected);
      } catch (err) {
        log("reconcile", `convergence failed on ${server.name}: ${err}`);
      }
    }),
  );
}

/**
 * Drift-repair the panel's own vhost from DB state. Bootstrap writes the
 * first panel.yml (via deployTraefikPanelSite, before a panel row exists);
 * this keeps it converged afterwards, so a wiped /etc/traefik/dynamic or a
 * rebuilt panel server heals within one reconciler tick instead of leaving
 * the control plane unroutable. Content-hashed: steady-state ticks write
 * nothing, so live panel WebSocket/terminal sessions are never disturbed.
 */
export async function reconcilePanelSite(): Promise<void> {
  const panel = db.getPanel();
  if (!panel || !panel.domain || !panel.host_port) return;
  const server = getPanelAccess();
  if (!server) return;
  const content = renderPanelConfig(
    panel.domain,
    panel.host_port,
    db.getSettings()["dns_zone_name"] ?? "",
  );
  const hash = contentHash(content);
  if (getCachedHash(server.ipv4, TRAEFIK_PANEL_CONFIG_PATH) === hash) return;
  await writeRemoteConfigAtomic(server, TRAEFIK_PANEL_CONFIG_PATH, content);
  setCachedHash(server.ipv4, TRAEFIK_PANEL_CONFIG_PATH, hash);
  log("panel", `wrote panel.yml on ${server.name} (${panel.domain})`);
}

/**
 * Write the panel's own vhost to /etc/traefik/dynamic/panel.yml. Called from
 * panel bootstrap — the engine's ocd.yml renderer never touches this file,
 * and after bootstrap reconcilePanelSite() owns keeping it converged. Runs
 * against an explicit server because bootstrap's DB has no panel row
 * relationship to lean on yet.
 */
export async function deployTraefikPanelSite(
  serverIp: string,
  domain: string,
  hostPort: number,
  zoneName: string = "",
  hostKey?: string,
): Promise<void> {
  log("panel", `Deploying panel vhost: domain=${domain} port=${hostPort} zone=${zoneName || "none"}`);
  const server: ServerAccess = {
    name: serverIp,
    ipv4: serverIp,
    hostKey,
  };
  await writeRemoteConfigAtomic(
    server,
    TRAEFIK_PANEL_CONFIG_PATH,
    renderPanelConfig(domain, hostPort, zoneName),
  );
  log("panel", "Panel vhost written (Traefik hot-reloads via the file provider)");
}
