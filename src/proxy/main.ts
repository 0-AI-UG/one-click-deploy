// ocd-proxy entrypoint. Runs on every fleet server as a compiled binary
// (scripts/build-proxy analog of build-cli.ts) and proxies all internal
// app-to-app traffic addressed to per-app VIPs, per the config file the
// control plane renders.

import { loadConfig, watchConfig, type ProxyConfig } from "./config.ts";
import { createListenerSet } from "./listeners.ts";
import { httpWake, type WakeFn } from "./wake.ts";

// Injected at compile time via `bun build --define OCD_PROXY_VERSION=...`;
// absent under `bun run` (dev), so `typeof` keeps the reference safe.
declare const OCD_PROXY_VERSION: string | undefined;

export const VERSION: string = typeof OCD_PROXY_VERSION !== "undefined" ? OCD_PROXY_VERSION : "dev";

function listenerCount(config: ProxyConfig): number {
  return config.apps.reduce((n, app) => n + app.listeners.length, 0);
}

function makeWake(config: ProxyConfig): WakeFn {
  if (config.wakeUrl) return httpWake(config.wakeUrl, config.wakeSecret);
  return async (app) => {
    throw new Error(`no wakeUrl configured — cannot wake app ${app.appId}`);
  };
}

export async function runProxy(argv: string[]): Promise<void> {
  if (argv.includes("--version")) {
    console.log(VERSION);
    process.exit(0);
  }
  const idx = argv.indexOf("--config");
  const configPath = idx >= 0 ? argv[idx + 1] : undefined;
  if (!configPath) {
    console.error("[proxy] usage: ocd-proxy --config <path>");
    process.exit(1);
  }

  let config = await loadConfig(configPath);
  let wakeImpl = makeWake(config);
  // Stable WakeFn wrapper so listeners survive wakeUrl/secret changes on reload.
  const wake: WakeFn = (app) => wakeImpl(app);
  const listeners = createListenerSet(wake);
  await listeners.reconcile(config);
  console.log(
    `[proxy] ocd-proxy ${VERSION} up — ${config.apps.length} apps, ${listenerCount(config)} listeners (${listeners.size()} bound)`,
  );

  const stopWatch = watchConfig(configPath, (next) => {
    if (next.wakeUrl !== config.wakeUrl || next.wakeSecret !== config.wakeSecret) wakeImpl = makeWake(next);
    config = next;
    void listeners.reconcile(next).then(() => {
      console.log(`[proxy] config reloaded — ${next.apps.length} apps, ${listenerCount(next)} listeners`);
    });
  });

  process.on("SIGTERM", () => {
    console.log("[proxy] SIGTERM — shutting down");
    stopWatch();
    listeners.stopAll();
    process.exit(0);
  });
}

if (import.meta.main) {
  void runProxy(process.argv.slice(2));
}
