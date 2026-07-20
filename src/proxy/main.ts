// ocd-proxy entrypoint. Runs on every fleet server as a compiled binary
// (scripts/build-proxy analog of build-cli.ts) and proxies all internal
// app-to-app traffic addressed to per-app VIPs, per the config file the
// control plane renders.

import { parseConfig, watchConfig, PROXY_LISTEN_PORT, type ProxyConfig } from "./config.ts";
import { createListenerSet } from "./listeners.ts";
import { applyNatRuleset, renderNatRuleset } from "./nat.ts";
import { startStatusServer } from "./status.ts";
import { httpWake, type WakeFn } from "./wake.ts";

// Injected at compile time via `bun build --define OCD_PROXY_VERSION=...`;
// absent under `bun run` (dev), so `typeof` keeps the reference safe.
declare const OCD_PROXY_VERSION: string | undefined;

export const VERSION: string = typeof OCD_PROXY_VERSION !== "undefined" ? OCD_PROXY_VERSION : "dev";

// Periodic self-heal: re-run listener reconcile + NAT sync even when the
// config never changes, so a transiently failed VIP bind or `nft -f` recovers
// without waiting for the next config write. Injectable for tests.
export const RECONCILE_INTERVAL_MS = 60_000;

function makeWake(config: ProxyConfig): WakeFn {
  if (config.wakeUrl) return httpWake(config.wakeUrl, config.wakeSecret);
  return async (app) => {
    throw new Error(`no wakeUrl configured — cannot wake app ${app.appId}`);
  };
}

export async function runProxy(
  argv: string[],
  opts?: { reconcileIntervalMs?: number },
): Promise<{ stop(): void }> {
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

  const configText = await Bun.file(configPath).text();
  let config = parseConfig(configText);
  let wakeImpl = makeWake(config);
  // Stable WakeFn wrapper so listeners survive wakeUrl/secret changes on reload.
  const wake: WakeFn = (app) => wakeImpl(app);
  const listeners = createListenerSet(wake);

  // Last successfully applied nft ruleset: re-apply only when the render
  // changes. Assigned only on success — a failed apply leaves it stale, so the
  // no-op skip below never absorbs a failure and the next sync (reload or
  // periodic tick) retries it. natApplied feeds the status endpoint.
  let appliedRuleset: string | null = null;
  let natApplied = false;
  const syncNat = async (cfg: ProxyConfig): Promise<void> => {
    const ruleset = renderNatRuleset(cfg.apps);
    if (ruleset === appliedRuleset) return;
    try {
      await applyNatRuleset(ruleset);
      appliedRuleset = ruleset;
      natApplied = true;
    } catch (err) {
      natApplied = false;
      console.error(
        `[proxy] FAILED to apply nat ruleset: ${err} — front ports will not redirect (listeners still serve :${cfg.listenPort ?? PROXY_LISTEN_PORT}); retrying on next reload`,
      );
    }
  };

  await listeners.reconcile(config);
  await syncNat(config);
  console.log(`[proxy] ocd-proxy ${VERSION} up — ${config.apps.length} apps (${listeners.size()} listeners bound)`);

  // Loopback status endpoint for the panel's readiness/idle scraping. A bind
  // failure (port taken) degrades observability only — never fatal.
  let status: { port: number; stop(): void } | null = null;
  try {
    status = startStatusServer({
      natApplied: () => natApplied,
      listenersBound: () => listeners.size(),
      listenersTotal: () => listeners.desiredSize(),
    });
    console.log(`[proxy] status endpoint on 127.0.0.1:${status.port}`);
  } catch (err) {
    console.error(`[proxy] status server bind failed: ${err} — continuing without /status`);
  }

  const stopWatch = watchConfig(
    configPath,
    (next) => {
      if (next.wakeUrl !== config.wakeUrl || next.wakeSecret !== config.wakeSecret) wakeImpl = makeWake(next);
      config = next;
      void listeners
        .reconcile(next)
        .then(() => syncNat(next))
        .then(() => {
          console.log(`[proxy] config reloaded — ${next.apps.length} apps (${listeners.size()} listeners bound)`);
        });
    },
    undefined,
    configText,
  );

  // Periodic self-heal: retry failed VIP binds and failed nft applies with an
  // unchanged config. Successful state is untouched — reconcile diffs by vip
  // and syncNat string-compares renders, so healthy ticks are no-ops.
  const reconcileTimer = setInterval(() => {
    void listeners.reconcile(config).then(() => syncNat(config));
  }, opts?.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);

  const stop = (): void => {
    stopWatch();
    clearInterval(reconcileTimer);
    listeners.stopAll();
    status?.stop();
  };

  process.on("SIGTERM", () => {
    // Deliberately leaves the nat table in place: readiness gating elsewhere
    // handles dead-proxy safety, and flushing would break the no-op restart case.
    console.log("[proxy] SIGTERM — shutting down");
    stop();
    process.exit(0);
  });

  return { stop };
}

if (import.meta.main) {
  void runProxy(process.argv.slice(2));
}
