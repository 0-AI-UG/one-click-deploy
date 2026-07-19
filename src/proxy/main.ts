// ocd-proxy entrypoint. Runs on every fleet server as a compiled binary
// (scripts/build-proxy analog of build-cli.ts) and proxies all internal
// app-to-app traffic addressed to per-app VIPs, per the config file the
// control plane renders.

import { loadConfig, watchConfig, PROXY_LISTEN_PORT, type ProxyConfig } from "./config.ts";
import { createListenerSet } from "./listeners.ts";
import { applyNatRuleset, renderNatRuleset } from "./nat.ts";
import { httpWake, type WakeFn } from "./wake.ts";

// Injected at compile time via `bun build --define OCD_PROXY_VERSION=...`;
// absent under `bun run` (dev), so `typeof` keeps the reference safe.
declare const OCD_PROXY_VERSION: string | undefined;

export const VERSION: string = typeof OCD_PROXY_VERSION !== "undefined" ? OCD_PROXY_VERSION : "dev";

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

  // Last successfully applied nft ruleset: re-apply only when the render
  // changes; after a failure it stays stale so the next reload retries.
  let appliedRuleset: string | null = null;
  const syncNat = async (cfg: ProxyConfig): Promise<void> => {
    const ruleset = renderNatRuleset(cfg.apps);
    if (ruleset === appliedRuleset) return;
    try {
      await applyNatRuleset(ruleset);
      appliedRuleset = ruleset;
    } catch (err) {
      console.error(
        `[proxy] FAILED to apply nat ruleset: ${err} — front ports will not redirect (listeners still serve :${cfg.listenPort ?? PROXY_LISTEN_PORT}); retrying on next reload`,
      );
    }
  };

  await listeners.reconcile(config);
  await syncNat(config);
  console.log(`[proxy] ocd-proxy ${VERSION} up — ${config.apps.length} apps (${listeners.size()} listeners bound)`);

  const stopWatch = watchConfig(configPath, (next) => {
    if (next.wakeUrl !== config.wakeUrl || next.wakeSecret !== config.wakeSecret) wakeImpl = makeWake(next);
    config = next;
    void listeners
      .reconcile(next)
      .then(() => syncNat(next))
      .then(() => {
        console.log(`[proxy] config reloaded — ${next.apps.length} apps (${listeners.size()} listeners bound)`);
      });
  });

  process.on("SIGTERM", () => {
    // Deliberately leaves the nat table in place: readiness gating elsewhere
    // handles dead-proxy safety, and flushing would break the no-op restart case.
    console.log("[proxy] SIGTERM — shutting down");
    stopWatch();
    listeners.stopAll();
    process.exit(0);
  });
}

if (import.meta.main) {
  void runProxy(process.argv.slice(2));
}
