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
import { mkdirSync, readdirSync, renameSync } from "fs";
import * as db from "../../shared/db.ts";
import { DATA_DIR } from "../../shared/paths.ts";
import { sshExec, getSshKeyPath } from "../../shared/remote/index.ts";
import { collectDesiredState, type DesiredState } from "./traefik-render.ts";
import { renderProxyConfigJson } from "./proxy-render.ts";
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

async function compileProxy(version: string, arch: "x64" | "arm64"): Promise<string> {
  const outfile = path.join(BUILD_CACHE_DIR, `ocd-proxy-${version}-linux-${arch}`);
  if (await Bun.file(outfile).exists()) return outfile;
  mkdirSync(BUILD_CACHE_DIR, { recursive: true });
  // Compile to a tmp name + rename so a killed build never leaves a partial
  // binary under the cacheable name.
  const tmpfile = `${outfile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  log("build", `compiling ocd-proxy ${version} for linux-${arch}`);
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
  renameSync(tmpfile, outfile);
  return outfile;
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

type ProxyProbe = {
  arch: string;
  version: string;
  active: string;
  unitSha: string;
  configSha: string;
};

/** One SSH round trip reporting everything convergence needs: machine arch
 *  (which binary to build), installed binary version, unit state, and the
 *  on-disk hash of the unit + config. Mirrors probeServerTraefik. */
export async function probeServerProxy(server: ServerAccess): Promise<ProxyProbe> {
  const cmd = [
    `M=$(uname -m)`,
    `V=$(${PROXY_BIN_PATH} --version 2>/dev/null || true)`,
    `A=$(systemctl is-active ocd-proxy 2>/dev/null || true)`,
    `sha() { sha256sum "$1" 2>/dev/null | cut -d" " -f1; }`,
    `echo "$M|$V|$A|$(sha ${PROXY_UNIT_PATH})|$(sha ${PROXY_CONFIG_PATH})"`,
  ].join("\n");
  const result = await sshExec(server.ipv4, cmd, server.hostKey);
  if (result.exitCode !== 0) {
    throw new Error(`proxy probe failed on ${server.name}: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout.trim().split("\n").pop() ?? "";
  const [arch = "", version = "", active = "", unitSha = "", configSha = ""] = line.split("|");
  return { arch, version, active, unitSha, configSha };
}

function archFromUname(uname: string): "x64" | "arm64" {
  if (uname === "aarch64" || uname === "arm64") return "arm64";
  return "x64";
}

/** Build (or reuse) the right-arch binary, ship it, install, (re)write the
 *  unit, and restart — the only restart path. Throws on any failure. */
async function installProxy(server: ServerAccess, arch: "x64" | "arm64"): Promise<void> {
  const binPath = await buildProxyBinary(arch);
  const tmpPath = `/tmp/.ocd-proxy.${crypto.randomUUID().slice(0, 8)}`;
  log("install", `installing ocd-proxy on ${server.name} (${server.ipv4}, linux-${arch})`);
  await scpTo(server, binPath, tmpPath);
  const result = await sshExec(server.ipv4, proxyInstallScript(tmpPath), server.hostKey);
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
 */
export async function convergeServerProxy(
  server: ServerAccess,
  opts: { state?: DesiredState; renderedConfig?: string } = {},
): Promise<void> {
  const rendered = opts.renderedConfig ?? renderProxyConfigJson(opts.state ?? collectDesiredState());
  const desiredVersion = await desiredProxyVersion();
  const probe = await probeServerProxy(server);

  // Mode 600 — the config embeds the wake secret.
  if (probe.configSha !== remoteFileSha(rendered)) {
    await writeRemoteFileAtomic(server, PROXY_CONFIG_PATH, rendered, "600");
    log("sync", `wrote config.json on ${server.name}`);
  }

  if (probe.version !== desiredVersion || probe.active !== "active") {
    log(
      "reconcile",
      `${server.name}: ocd-proxy=${probe.version || "missing"} (want ${desiredVersion}) unit=${probe.active || "unknown"} → install`,
    );
    await installProxy(server, archFromUname(probe.arch));
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
  }
}

// --- Readiness gate ----------------------------------------------------------

// ipv4 → whether the last converge confirmed the proxy live (unit active with
// current binary + config). In-memory on purpose: a panel restart forgets all
// readiness, /etc/hosts stays on the safe private-IP lines for one tick, and
// the first reconcile re-proves every server.
const proxyReady = new Map<string, boolean>();

/** True only after a converge/probe confirmed this server's ocd-proxy active
 *  and current. Gates the /etc/hosts VIP flip in syncInternalHosts — a server
 *  whose proxy isn't verifiably live keeps resolving apps via local Traefik. */
export function isProxyReady(ipv4: string): boolean {
  return proxyReady.get(ipv4) === true;
}

/**
 * Reconciler entrypoint: render once, converge every ready server in
 * parallel. Per-server failures are logged, mark the server not-ready (its
 * hosts entries fall back to local Traefik next network sync), and retry
 * next tick.
 */
export async function reconcileProxy(): Promise<void> {
  const state = collectDesiredState();
  const rendered = renderProxyConfigJson(state);
  await Promise.all(
    getAllServerAccess().map(async (server) => {
      try {
        await convergeServerProxy(server, { renderedConfig: rendered });
        proxyReady.set(server.ipv4, true);
      } catch (err) {
        proxyReady.set(server.ipv4, false);
        log("reconcile", `convergence failed on ${server.name}: ${err}`);
      }
    }),
  );
}
