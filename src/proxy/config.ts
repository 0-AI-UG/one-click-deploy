// ocd-proxy config: types, loading/validation, and the poll-based reloader.
// The proxy is pure mechanism — which VIPs/ports to serve is decided by the
// control plane and arrives exclusively through this file. Keep this module
// (and the whole of src/proxy/) free of imports from the rest of the repo so
// the compiled binary stays small.

/**
 * The one TCP port the proxy actually binds per VIP. Traefik holds wildcard
 * 0.0.0.0 listeners on :80 and :20000-20199, and on Linux a specific-IP listen
 * can never coexist with a wildcard listen on the same port — so the
 * user-facing front ports are DNATed to this wildcard-free port (see nat.ts).
 */
export const PROXY_LISTEN_PORT = 18790;

/**
 * The one TCP/UDP port the proxy binds per VIP for PUBLIC raw ingress (the
 * 30000-30099 pool, DNATed here — see nat.ts). Distinct from the internal
 * PROXY_LISTEN_PORT so a single VIP can host both paths at once: the internal
 * listener fail-closes password-protected apps, but the public raw path is
 * deliberately auth-free (Traefik served it unauthenticated), and after DNAT
 * the original port is gone — the two listen ports are the only thing that
 * still distinguishes public from internal.
 */
export const PROXY_PUBLIC_LISTEN_PORT = 18789;

export type ProxyListener = { port: number; protocol: "tcp" | "udp" };

export type ProxyApp = {
  appId: number;
  name: string;
  vip: string;
  /** User-visible ports on the VIP (80/container_port/internal_port…) — DNATed to the listen port, never bound. */
  frontPorts: number[];
  backends: string[];
  sleeping: boolean;
  /** App requires credentials the L4 proxy cannot check — fail closed (destroy accepted connections). */
  authProtected?: boolean;
  /** Public raw port on the panel's public IP (30000-30099); DNATed to the
   *  public listen port. Absent when the app is not raw-exposed. */
  publicPort?: number;
  /** Pool for publicPort (default "tcp"). */
  publicProtocol?: "tcp" | "udp";
};

export type ProxyConfig = {
  version: 1;
  wakeUrl: string | null;
  wakeSecret: string;
  /** The panel's public IPv4 — DNAT `daddr` for the public raw path, so the
   *  byte-identical config only intercepts public traffic on the panel. Null
   *  until the panel's IP is known; the public rules are then omitted. */
  publicIngressIp?: string | null;
  /** Test seam: per-VIP internal listen port override (default PROXY_LISTEN_PORT). The renderer never sets it. */
  listenPort?: number;
  /** Test seam: per-VIP public listen port override (default PROXY_PUBLIC_LISTEN_PORT). The renderer never sets it. */
  publicListenPort?: number;
  apps: ProxyApp[];
};

function fail(msg: string): never {
  throw new Error(`invalid proxy config: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePort(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535)
    fail(`${where} must be an integer in 1-65535`);
  return v;
}

function validateApp(raw: unknown, index: number): ProxyApp {
  const where = `apps[${index}]`;
  if (!isRecord(raw)) fail(`${where}: must be an object`);
  const { appId, name, vip, frontPorts, backends, sleeping, authProtected, publicPort, publicProtocol } = raw;
  if (typeof appId !== "number" || !Number.isInteger(appId)) fail(`${where}: appId must be an integer`);
  if (typeof name !== "string" || name.length === 0) fail(`${where}: name must be a non-empty string`);
  if (typeof vip !== "string" || vip.length === 0) fail(`${where}: vip must be a non-empty string`);
  if (!Array.isArray(frontPorts) || frontPorts.length === 0) fail(`${where}: frontPorts must be a non-empty array`);
  if (!Array.isArray(backends)) fail(`${where}: backends must be an array`);
  for (const b of backends) {
    if (typeof b !== "string" || !/^.+:\d+$/.test(b)) fail(`${where}: backend ${JSON.stringify(b)} must be "host:port"`);
  }
  if (typeof sleeping !== "boolean") fail(`${where}: sleeping must be a boolean`);
  if (authProtected !== undefined && typeof authProtected !== "boolean")
    fail(`${where}: authProtected must be a boolean`);
  if (publicPort !== undefined) validatePort(publicPort, `${where}.publicPort`);
  if (publicProtocol !== undefined && publicProtocol !== "tcp" && publicProtocol !== "udp")
    fail(`${where}: publicProtocol must be "tcp" or "udp"`);
  return {
    appId,
    name,
    vip,
    frontPorts: frontPorts.map((p, i) => validatePort(p, `${where}.frontPorts[${i}]`)),
    backends: backends as string[],
    sleeping,
    ...(authProtected !== undefined ? { authProtected } : {}),
    ...(publicPort !== undefined ? { publicPort: publicPort as number } : {}),
    ...(publicProtocol !== undefined ? { publicProtocol: publicProtocol as "tcp" | "udp" } : {}),
  };
}

export function parseConfig(text: string): ProxyConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`not valid JSON (${err})`);
  }
  if (!isRecord(raw)) fail("root must be an object");
  if (raw.version !== 1) fail(`unknown version ${JSON.stringify(raw.version)} (expected 1)`);
  if (raw.wakeUrl !== null && typeof raw.wakeUrl !== "string") fail("wakeUrl must be a string or null");
  if (typeof raw.wakeSecret !== "string") fail("wakeSecret must be a string");
  if (raw.publicIngressIp !== undefined && raw.publicIngressIp !== null && typeof raw.publicIngressIp !== "string")
    fail("publicIngressIp must be a string or null");
  if (raw.listenPort !== undefined) validatePort(raw.listenPort, "listenPort");
  if (raw.publicListenPort !== undefined) validatePort(raw.publicListenPort, "publicListenPort");
  if (!Array.isArray(raw.apps)) fail("apps must be an array");
  return {
    version: 1,
    wakeUrl: raw.wakeUrl,
    wakeSecret: raw.wakeSecret,
    ...(raw.publicIngressIp !== undefined ? { publicIngressIp: raw.publicIngressIp as string | null } : {}),
    ...(raw.listenPort !== undefined ? { listenPort: raw.listenPort as number } : {}),
    ...(raw.publicListenPort !== undefined ? { publicListenPort: raw.publicListenPort as number } : {}),
    apps: raw.apps.map(validateApp),
  };
}

export async function loadConfig(path: string): Promise<ProxyConfig> {
  return parseConfig(await Bun.file(path).text());
}

const WATCH_INTERVAL_MS = 2000;

/**
 * Poll `path` every 2s and invoke `onChange` with the parsed config whenever
 * the file content actually changed (compared by hash). Transient read/parse
 * errors are logged and the previous config stays in effect. Returns a stop
 * function.
 *
 * Pass `initialText` (the text the startup load already read) to seed the
 * change-detection baseline synchronously — an async re-read can absorb a
 * write that lands between the startup load and the first poll, silently
 * losing that change.
 */
export function watchConfig(
  path: string,
  onChange: (config: ProxyConfig) => void,
  intervalMs: number = WATCH_INTERVAL_MS,
  initialText?: string,
): () => void {
  let lastHash: bigint | null = initialText !== undefined ? (Bun.hash(initialText) as bigint) : null;

  // No initial text: seed the baseline by re-reading, so the config loaded at
  // startup doesn't fire a spurious "reload" on the first poll.
  if (initialText === undefined) {
    void Bun.file(path)
      .text()
      .then((text) => {
        if (lastHash === null) lastHash = Bun.hash(text) as bigint;
      })
      .catch(() => {});
  }

  const timer = setInterval(async () => {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (err) {
      console.error(`[proxy] config read failed (${path}): ${err} — keeping current config`);
      return;
    }
    const hash = Bun.hash(text) as bigint;
    if (hash === lastHash) return;
    lastHash = hash; // even on parse failure: log broken content once, not every poll
    try {
      onChange(parseConfig(text));
    } catch (err) {
      console.error(`[proxy] config reload failed: ${err} — keeping current config`);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
