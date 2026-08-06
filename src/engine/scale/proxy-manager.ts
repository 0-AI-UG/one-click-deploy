// ocd-proxy fleet manager — owns every server's /usr/local/bin/ocd-proxy
// binary, its systemd unit, and /etc/ocd-proxy/config.json. Same shape as
// traefik-manager: a single-round-trip probe reports binary version, unit
// state and on-disk config/unit hashes; convergence rewrites exactly what
// drifted. Config-only changes need no restart (the proxy hot-reloads by
// polling); binary/unit drift reinstalls + restarts.
//
// Unlike Traefik the binary isn't downloaded from a release — the panel
// cross-compiles src/proxy/ with `bun build --compile` per architecture and
// scp-s the result. The injected OCD_PROXY_VERSION (short content hash of the
// proxy sources) doubles as the fleet-wide drift detector: editing src/proxy/
// rolls the fleet within one reconciler tick.
//
// isProxyReady() is the safety gate for the /etc/hosts VIP flip: a server's
// app lines only point at VIPs once a converge has confirmed its proxy unit
// active with current binary + config (see network-reconciler).

import path from "path";
import os from "os";
import { mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import * as db from "../../shared/db.ts";
import { DATA_DIR } from "../../shared/paths.ts";
import { sshExec, getSshKeyPath } from "../../shared/remote/index.ts";
import { STATUS_PORT as PROXY_STATUS_PORT } from "../../proxy/status.ts";
import { collectDesiredState, type DesiredState } from "./traefik-render.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../scheduler.ts";
import { renderProxyConfigJson } from "./proxy-render.ts";
import { ingestProxyActivity } from "./request-metrics.ts";
import {
  PROXY_BIN_PATH,
  PROXY_CONFIG_PATH,
  PROXY_UNIT_PATH,
  proxyInstallScript,
  proxySystemdUnit,
} from "./proxy-provision.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [proxy-mgr:${context}]`, ...args);
}

export type ServerAccess = {
  name: string;
  ipv4: string;
  hostKey: string | undefined;
  /** servers.id — lets the converge pass feed the proxy's activity report
   *  into request-metrics. Optional: probe-only callers don't need it. */
  id?: number;
};

// Same addressing rule as traefik-manager: only `ready` servers — SSHing a
// creating/provisioning box is a guaranteed failure (the first post-ready
// converge installs the proxy; cloud-init doesn't) and a destroying one is gone.
function getAllServerAccess(): ServerAccess[] {
  return db
    .getServers()
    .filter((s) => s.ipv4 && s.status === "ready")
    .map((s) => ({
      name: s.name,
      ipv4: s.ipv4,
      hostKey: s.ssh_host_key || undefined,
      id: s.id,
    }));
}

// --- Binary build cache ------------------------------------------------------

const PROXY_SRC_DIR = path.resolve(import.meta.dir, "../../proxy");
const BUILD_CACHE_DIR = path.join(DATA_DIR, "proxy-build");

/**
 * Short content hash of the proxy's compiled sources (src/proxy/*.ts, tests
 * excluded — they aren't part of the binary). Injected as OCD_PROXY_VERSION
 * at build time and reported by `ocd-proxy --version`: probe-vs-desired
 * version mismatch is the binary drift signal.
 */
export async function desiredProxyVersion(): Promise<string> {
  const files = readdirSync(PROXY_SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hasher.update(`${file}\n`);
    hasher.update(await Bun.file(path.join(PROXY_SRC_DIR, file)).text());
  }
  return hasher.digest("hex").slice(0, 12);
}

// In-flight/completed builds per version+arch, so parallel converges across
// the fleet share one compile. Failed builds are evicted for retry.
const builds = new Map<string, Promise<string>>();

function pruneSupersededProxyBinaries(keepPath: string, arch: "x64" | "arm64"): void {
  try {
    for (const file of readdirSync(BUILD_CACHE_DIR)) {
      if (!file.startsWith("ocd-proxy-") || !file.endsWith(`-linux-${arch}`)) continue;
      const candidate = path.join(BUILD_CACHE_DIR, file);
      if (candidate !== keepPath) rmSync(candidate, { force: true });
    }
  } catch {
    // Cache cleanup is best-effort; a valid current binary must still ship.
  }
}

/** True for an OCD proxy cache artifact from a different source revision.
 * Unknown files are never candidates. */
export function isSupersededProxyBinary(file: string, desiredVersion: string): boolean {
  const match = /^ocd-proxy-([0-9a-f]{12})-linux-(x64|arm64)$/.exec(file);
  return match !== null && match[1] !== desiredVersion;
}

/** Steady-state cleanup matters because a fully converged fleet never calls
 * buildProxyBinary, so cleanup tied only to cache hits/builds leaves every
 * historical ~100 MB binary on the persistent panel volume forever. */
async function pruneProxyBuildCache(): Promise<void> {
  const desiredVersion = await desiredProxyVersion();
  try {
    for (const file of readdirSync(BUILD_CACHE_DIR)) {
      if (isSupersededProxyBinary(file, desiredVersion)) {
        rmSync(path.join(BUILD_CACHE_DIR, file), { force: true });
      }
    }
  } catch {
    // Cache cleanup is best-effort and must not block topology convergence.
  }
}

export async function buildProxyBinary(arch: "x64" | "arm64"): Promise<string> {
  const version = await desiredProxyVersion();
  const key = `${version}-${arch}`;
  let build = builds.get(key);
  if (!build) {
    build = compileProxy(version, arch);
    builds.set(key, build);
    build.catch(() => builds.delete(key));
  }
  return build;
}

/** True when the file exists and starts with the ELF magic. Guards against
 *  bun's silent zero-fill (below) both for fresh builds and for cache hits —
 *  a poisoned cache entry must rebuild, not reship. */
async function isValidElf(file: string): Promise<boolean> {
  const f = Bun.file(file);
  if (!(await f.exists()) || f.size < 4) return false;
  const magic = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  return magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
}

function hostArch(): "x64" | "arm64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

async function fileSha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(file).arrayBuffer());
  return hasher.digest("hex");
}

async function compileProxy(version: string, arch: "x64" | "arm64"): Promise<string> {
  const outfile = path.join(BUILD_CACHE_DIR, `ocd-proxy-${version}-linux-${arch}`);
  if (await isValidElf(outfile)) {
    pruneSupersededProxyBinaries(outfile, arch);
    return outfile;
  }
  rmSync(outfile, { force: true });
  mkdirSync(BUILD_CACHE_DIR, { recursive: true });
  // bun 1.3.x `--compile` silently writes an all-zero file when --outfile
  // crosses a filesystem boundary (observed: container overlayfs → the
  // bind-mounted data volume). Build on bun's own filesystem (tmpdir), verify
  // the ELF, then byte-copy into the cache and verify the copy.
  const tmpfile = path.join(os.tmpdir(), `ocd-proxy-build.${crypto.randomUUID().slice(0, 8)}`);
  log("build", `compiling ocd-proxy ${version} for linux-${arch}`);
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        path.join(PROXY_SRC_DIR, "main.ts"),
        "--compile",
        `--target=bun-linux-${arch}`,
        "--define",
        `OCD_PROXY_VERSION=${JSON.stringify(version)}`,
        "--outfile",
        tmpfile,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`ocd-proxy build failed for linux-${arch} (exit ${exit}): ${stderr.trim().slice(0, 400)}`);
    }
    if (!(await isValidElf(tmpfile))) {
      throw new Error(`ocd-proxy build for linux-${arch} produced a non-ELF file (bun --compile zero-fill?)`);
    }
    if (arch === hostArch() && process.platform === "linux") {
      const check = Bun.spawn([tmpfile, "--version"], { stdout: "pipe", stderr: "pipe" });
      await check.exited;
      const reported = (await new Response(check.stdout).text()).trim();
      if (reported !== version) {
        throw new Error(`ocd-proxy build self-check failed: --version reported "${reported}", want "${version}"`);
      }
    }
    const partial = `${outfile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Bun.write(partial, await Bun.file(tmpfile).arrayBuffer());
    if ((await fileSha256(partial)) !== (await fileSha256(tmpfile))) {
      rmSync(partial, { force: true });
      throw new Error(`ocd-proxy build copy into cache did not match the source (filesystem copy bug?)`);
    }
    renameSync(partial, outfile);
    pruneSupersededProxyBinaries(outfile, arch);
    return outfile;
  } finally {
    rmSync(tmpfile, { force: true });
  }
}

// --- Remote write plumbing (per-server lock + atomic tmp+mv, as in
// traefik-manager; separate lock map is fine — locks only order writes to the
// same file, and the two managers own disjoint files) -------------------------

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

async function writeRemoteFileAtomic(
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

function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** sha256 of a managed file as it exists remotely: every writer (the install
 *  script's heredoc, writeRemoteFileAtomic's printf) appends one trailing
 *  newline to the rendered content. */
function remoteFileSha(content: string): string {
  return sha256(content + "\n");
}

async function scpTo(server: ServerAccess, localPath: string, remotePath: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "scp",
      "-i", getSshKeyPath(),
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      localPath,
      `root@${server.ipv4}:${remotePath}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`scp ocd-proxy to ${server.name} failed (exit ${exit}): ${stderr.trim().slice(0, 400)}`);
  }
}

// --- Probe / converge --------------------------------------------------------

/** JSON served by the proxy's loopback /status endpoint (src/proxy/status.ts).
 *  `ok` = NAT ruleset applied && every desired VIP listener bound;
 *  `lastActivity` (appId-string → epoch ms) feeds idle detection. */
export type ProxyStatus = {
  ok: boolean;
  natApplied?: boolean;
  listenersBound?: number;
  listenersTotal?: number;
  lastActivity?: Record<string, number>;
};

const PROXY_STATUS_URL = `http://127.0.0.1:${PROXY_STATUS_PORT}/status`;

/** Parse a /status body. Returns null for empty/unreadable output — status
 *  "unknown" (trust the classic probe), distinct from an explicit ok:false. */
function parseProxyStatus(raw: string): ProxyStatus | null {
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean") {
      return parsed as ProxyStatus;
    }
  } catch {
    // fall through — an unreadable status is "unknown", not "down"
  }
  return null;
}

type ProxyProbe = {
  arch: string;
  version: string;
  active: string;
  unitSha: string;
  configSha: string;
  /** Live /status snapshot piggybacked on the probe round trip; null when the
   *  proxy isn't serving its status endpoint (down, or an older binary). */
  status: ProxyStatus | null;
};

/** One SSH round trip reporting everything convergence needs: machine arch
 *  (which binary to build), installed binary version, unit state, the
 *  on-disk hash of the unit + config, and the proxy's own /status readiness
 *  report. Mirrors probeServerTraefik. */
export async function probeServerProxy(server: ServerAccess): Promise<ProxyProbe> {
  const cmd = [
    `M=$(uname -m)`,
    `V=$(${PROXY_BIN_PATH} --version 2>/dev/null || true)`,
    `A=$(systemctl is-active ocd-proxy 2>/dev/null || true)`,
    `S=$(curl -sf --max-time 5 ${PROXY_STATUS_URL} 2>/dev/null || true)`,
    `sha() { sha256sum "$1" 2>/dev/null | cut -d" " -f1; }`,
    `echo "$M|$V|$A|$(sha ${PROXY_UNIT_PATH})|$(sha ${PROXY_CONFIG_PATH})|$S"`,
  ].join("\n");
  const result = await sshExec(server.ipv4, cmd, server.hostKey);
  if (result.exitCode !== 0) {
    throw new Error(`proxy probe failed on ${server.name}: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const parts = line.split("|");
  const [arch = "", version = "", active = "", unitSha = "", configSha = ""] = parts;
  // The status JSON is the last field; it contains no "|" itself, but rejoin
  // defensively so a future payload change can't silently truncate it.
  const status = parseProxyStatus(parts.slice(5).join("|"));
  return { arch, version, active, unitSha, configSha, status };
}

/** Fetch /status in its own round trip — used after an install/restart, when
 *  the probe's piggybacked snapshot predates the new proxy process. */
async function fetchProxyStatus(server: ServerAccess): Promise<ProxyStatus | null> {
  const result = await sshExec(
    server.ipv4,
    `curl -sf --max-time 5 ${PROXY_STATUS_URL} 2>/dev/null || true`,
    server.hostKey,
  );
  if (result.exitCode !== 0) return null;
  return parseProxyStatus(result.stdout.trim());
}

function archFromUname(uname: string): "x64" | "arm64" {
  if (uname === "aarch64" || uname === "arm64") return "arm64";
  return "x64";
}

/** Build (or reuse) the right-arch binary, ship it, install, (re)write the
 *  unit, and restart — the only restart path. Throws on any failure. */
async function installProxy(server: ServerAccess, arch: "x64" | "arm64"): Promise<void> {
  const binPath = await buildProxyBinary(arch);
  const [sha, version] = await Promise.all([fileSha256(binPath), desiredProxyVersion()]);
  const tmpPath = `/tmp/.ocd-proxy.${crypto.randomUUID().slice(0, 8)}`;
  log("install", `installing ocd-proxy on ${server.name} (${server.ipv4}, linux-${arch})`);
  await scpTo(server, binPath, tmpPath);
  const result = await sshExec(
    server.ipv4,
    proxyInstallScript(tmpPath, { sha256: sha, version }),
    server.hostKey,
  );
  if (result.exitCode !== 0) {
    throw new Error(`ocd-proxy install failed on ${server.name}: ${result.stderr || result.stdout}`);
  }
  log("install", `ocd-proxy installed and running on ${server.name}`);
}

/**
 * Converge one server onto the desired proxy state, trusting only the remote
 * probe. Order matters: the config is written first so a fresh install's
 * `enable --now`/restart comes up against current config (the unit's
 * ExecStart needs the file to exist), and a binary upgrade restarts onto
 * current routes. Config-only drift ends there — the running proxy
 * hot-reloads the file within ~2s, no restart. Binary version drift or an
 * inactive unit reinstalls + restarts; unit-only drift rewrites the unit and
 * restarts.
 *
 * Returns the proxy's final /status snapshot (re-fetched after a restart so it
 * reflects the new process) — the readiness gate treats an explicit ok:false
 * as not-serving even when the unit converged cleanly.
 */
export async function convergeServerProxy(
  server: ServerAccess,
  opts: { state?: DesiredState; renderedConfig?: string } = {},
): Promise<{ status: ProxyStatus | null }> {
  const rendered = opts.renderedConfig ?? renderProxyConfigJson(opts.state ?? collectDesiredState());
  const desiredVersion = await desiredProxyVersion();
  const probe = await probeServerProxy(server);

  // Mode 600 — the config embeds the wake secret.
  if (probe.configSha !== remoteFileSha(rendered)) {
    await writeRemoteFileAtomic(server, PROXY_CONFIG_PATH, rendered, "600");
    log("sync", `wrote config.json on ${server.name}`);
  }

  let restarted = false;
  if (probe.version !== desiredVersion || probe.active !== "active") {
    log(
      "reconcile",
      `${server.name}: ocd-proxy=${probe.version || "missing"} (want ${desiredVersion}) unit=${probe.active || "unknown"} → install`,
    );
    await installProxy(server, archFromUname(probe.arch));
    restarted = true;
  } else if (probe.unitSha !== remoteFileSha(proxySystemdUnit())) {
    log("reconcile", `${server.name}: unit drift → rewrite + restart`);
    await writeRemoteFileAtomic(server, PROXY_UNIT_PATH, proxySystemdUnit());
    const restart = await sshExec(
      server.ipv4,
      "systemctl daemon-reload && systemctl restart ocd-proxy",
      server.hostKey,
    );
    if (restart.exitCode !== 0) {
      throw new Error(`ocd-proxy restart failed on ${server.name}: ${restart.stderr || restart.stdout}`);
    }
    restarted = true;
  }

  return { status: restarted ? await fetchProxyStatus(server) : probe.status };
}

// --- Readiness gate ----------------------------------------------------------

// ipv4 → whether the last converge confirmed the proxy live (unit active with
// current binary + config). In-memory on purpose: a panel restart forgets all
// readiness, /etc/hosts stays on the safe private-IP lines for one tick, and
// the first reconcile re-proves every server.
const proxyReady = new Map<string, boolean>();

// Servers whose proxy was confirmed live at least once this process. Drives
// the /etc/hosts last-known-good policy (syncInternalHosts): a later converge
// failure keeps the previously-rendered VIP lines — the proxy is almost
// certainly still running with its last config — instead of rewriting them to
// lines that route nowhere.
const proxyEverReady = new Set<string>();

/** True only after a converge/probe confirmed this server's ocd-proxy active
 *  and current (unit + binary + config, and /status not reporting ok:false). */
export function isProxyReady(ipv4: string): boolean {
  return proxyReady.get(ipv4) === true;
}

/** True once a converge has EVER confirmed this server's proxy live in this
 *  process. Gates the /etc/hosts app lines: never-proven servers get none. */
export function wasProxyEverReady(ipv4: string): boolean {
  return proxyEverReady.has(ipv4);
}

/** Converge one server and record the outcome in the readiness gate; also
 *  feeds the proxy's lastActivity report into idle detection. Never throws —
 *  a failure is logged, marks the server not-ready, and retries next tick. */
async function convergeAndTrack(server: ServerAccess, rendered: string): Promise<void> {
  try {
    const { status } = await convergeServerProxy(server, { renderedConfig: rendered });
    // An explicit ok:false means the unit is up but not actually serving (NAT
    // not applied / listeners unbound) → not ready. A missing/unreadable
    // status (transient curl failure) trusts the classic probe outcome.
    const ready = status ? status.ok : true;
    proxyReady.set(server.ipv4, ready);
    if (ready) proxyEverReady.add(server.ipv4);
    if (server.id !== undefined && status?.lastActivity) {
      ingestProxyActivity(server.id, { lastActivity: status.lastActivity });
    }
  } catch (err) {
    proxyReady.set(server.ipv4, false);
    log("reconcile", `convergence failed on ${server.name}: ${err}`);
  }
}

async function convergeAndTrackLocked(server: ServerAccess, rendered: string): Promise<void> {
  if (server.id === undefined) return convergeAndTrack(server, rendered);
  const keys = [`server:${server.id}`];
  const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:proxy");
  if (!lock.ok) return;
  try {
    await convergeAndTrack(server, rendered);
  } finally {
    release(keys);
  }
}

/**
 * Reconciler entrypoint: render once, converge every ready server in
 * parallel. Per-server failures are logged, mark the server not-ready, and
 * retry next tick.
 */
export async function reconcileProxy(): Promise<void> {
  await pruneProxyBuildCache();
  const state = collectDesiredState();
  const rendered = renderProxyConfigJson(state);
  await Promise.all(getAllServerAccess().map((server) => convergeAndTrackLocked(server, rendered)));
}

// --- Immediate topology push -------------------------------------------------

// Test seam mirroring __setWakerDeps: override (or, with null, restore) the
// implementation pushProxyForApp delegates to.
let proxyPush: ((appId: number) => Promise<void>) | null = null;

export function __setProxyPush(fn: ((appId: number) => Promise<void>) | null): void {
  proxyPush = fn;
}

/**
 * Immediately converge the ocd-proxy config on the servers hosting `appId`'s
 * replicas (including the sleeping anchor's server) after a topology change.
 * Sleep (scale-down) and wake call this so the fleet proxy stops routing the
 * app's VIP at dead backends / starts routing to the woken replica without
 * waiting for the 30s reconciler tick; servers not touching the app pick up
 * the identical fleet-wide config next tick. Best-effort: failures are logged
 * and retried by the reconciler, never thrown into the calling op.
 */
export async function pushProxyForApp(appId: number): Promise<void> {
  if (proxyPush) return proxyPush(appId);
  try {
    const app = db.getApp(appId);
    if (!app) return;
    const serverIds = new Set<number>(db.getReplicas(appId).map((r) => r.server_id));
    if (app.sleeping_server_id) serverIds.add(app.sleeping_server_id);
    const servers = getAllServerAccess().filter((s) => s.id !== undefined && serverIds.has(s.id));
    if (servers.length === 0) return;
    const rendered = renderProxyConfigJson(collectDesiredState());
    await Promise.all(servers.map((server) => convergeAndTrackLocked(server, rendered)));
  } catch (err) {
    log("push", `proxy push for app ${appId} failed: ${err}`);
  }
}
