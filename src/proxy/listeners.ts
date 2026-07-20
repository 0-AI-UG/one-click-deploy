// Reconcile the running listener set against a ProxyConfig: exactly one TCP
// listener per app at vip:listenPort (the user-facing front ports are DNATed
// to it by nat.ts, never bound). Diff by vip — close removed apps' listeners,
// open added ones, and swap each surviving listener's app snapshot in place
// (backends/sleeping changes apply to new connections only). Bind failures are
// logged, never fatal; the key stays absent so the next reconcile retries it.
//
// UDP is intentionally unwired here: no internal UDP apps exist yet. udp.ts
// stays the building block for a future frontPorts-for-udp variant.

import { PROXY_LISTEN_PORT, type ProxyApp, type ProxyConfig } from "./config.ts";
import { openTcpListener, type TcpListenerHandle } from "./tcp.ts";
import type { WakeFn } from "./wake.ts";

export type ListenerSet = {
  reconcile(config: ProxyConfig): Promise<void>;
  stopAll(): void;
  size(): number;
  /** Listeners the last reconciled config asked for (bound or not) — status uses size()/desiredSize() as bound/total. */
  desiredSize(): number;
};

export function createListenerSet(wake: WakeFn): ListenerSet {
  const handles = new Map<string, TcpListenerHandle>();
  let desiredCount = 0;

  return {
    async reconcile(config) {
      const port = config.listenPort ?? PROXY_LISTEN_PORT;
      const desired = new Map<string, ProxyApp>();
      for (const app of config.apps) desired.set(app.vip, app);
      desiredCount = desired.size;

      for (const [vip, handle] of [...handles]) {
        if (desired.has(vip)) continue;
        handle.stop();
        handles.delete(vip);
        console.log(`[proxy] closed ${vip}:${handle.port}`);
      }

      for (const [vip, app] of desired) {
        const existing = handles.get(vip);
        if (existing) {
          existing.update(app);
          continue;
        }
        try {
          const handle = openTcpListener(app, { port, protocol: "tcp" }, wake);
          handles.set(vip, handle);
          console.log(`[proxy] opened ${vip}:${handle.port} → app ${app.appId} (${app.name})`);
        } catch (err) {
          console.error(`[proxy] bind ${vip}:${port} failed: ${err} — will retry on next reconcile`);
        }
      }
    },
    stopAll() {
      for (const handle of handles.values()) handle.stop();
      handles.clear();
    },
    size() {
      return handles.size;
    },
    desiredSize() {
      return desiredCount;
    },
  };
}
