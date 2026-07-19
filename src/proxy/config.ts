// ocd-proxy config: types, loading/validation, and the poll-based reloader.
// The proxy is pure mechanism — which VIPs/ports to serve is decided by the
// control plane and arrives exclusively through this file. Keep this module
// (and the whole of src/proxy/) free of imports from the rest of the repo so
// the compiled binary stays small.

export type ProxyListener = { port: number; protocol: "tcp" | "udp" };

export type ProxyApp = {
  appId: number;
  name: string;
  vip: string;
  listeners: ProxyListener[];
  backends: string[];
  sleeping: boolean;
};

export type ProxyConfig = {
  version: 1;
  wakeUrl: string | null;
  wakeSecret: string;
  apps: ProxyApp[];
};

function fail(msg: string): never {
  throw new Error(`invalid proxy config: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateListener(raw: unknown, where: string): ProxyListener {
  if (!isRecord(raw)) fail(`${where}: listener must be an object`);
  const { port, protocol } = raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    fail(`${where}: listener port must be an integer in 1-65535`);
  if (protocol !== "tcp" && protocol !== "udp") fail(`${where}: listener protocol must be "tcp" or "udp"`);
  return { port, protocol };
}

function validateApp(raw: unknown, index: number): ProxyApp {
  const where = `apps[${index}]`;
  if (!isRecord(raw)) fail(`${where}: must be an object`);
  const { appId, name, vip, listeners, backends, sleeping } = raw;
  if (typeof appId !== "number" || !Number.isInteger(appId)) fail(`${where}: appId must be an integer`);
  if (typeof name !== "string" || name.length === 0) fail(`${where}: name must be a non-empty string`);
  if (typeof vip !== "string" || vip.length === 0) fail(`${where}: vip must be a non-empty string`);
  if (!Array.isArray(listeners)) fail(`${where}: listeners must be an array`);
  if (!Array.isArray(backends)) fail(`${where}: backends must be an array`);
  for (const b of backends) {
    if (typeof b !== "string" || !/^.+:\d+$/.test(b)) fail(`${where}: backend ${JSON.stringify(b)} must be "host:port"`);
  }
  if (typeof sleeping !== "boolean") fail(`${where}: sleeping must be a boolean`);
  return {
    appId,
    name,
    vip,
    listeners: listeners.map((l, i) => validateListener(l, `${where}.listeners[${i}]`)),
    backends: backends as string[],
    sleeping,
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
  if (!Array.isArray(raw.apps)) fail("apps must be an array");
  return {
    version: 1,
    wakeUrl: raw.wakeUrl,
    wakeSecret: raw.wakeSecret,
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
 */
export function watchConfig(
  path: string,
  onChange: (config: ProxyConfig) => void,
  intervalMs: number = WATCH_INTERVAL_MS,
): () => void {
  let lastHash: bigint | null = null;

  // Seed the baseline so the config just loaded at startup doesn't fire a
  // spurious "reload" on the first poll.
  void Bun.file(path)
    .text()
    .then((text) => {
      if (lastHash === null) lastHash = Bun.hash(text) as bigint;
    })
    .catch(() => {});

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
