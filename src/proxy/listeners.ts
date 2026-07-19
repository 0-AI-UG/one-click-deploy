// Reconcile the running listener set against a ProxyConfig: diff by
// (vip, port, protocol) — close removed listeners, open added ones, and swap
// each surviving listener's app snapshot in place (backends/sleeping changes
// apply to new connections only). Bind failures are logged, never fatal; the
// key stays absent so the next reconcile retries it.

import type { ProxyApp, ProxyConfig, ProxyListener } from "./config.ts";
import { openTcpListener, type TcpListenerHandle } from "./tcp.ts";
import { openUdpListener, type UdpListenerHandle } from "./udp.ts";
import type { WakeFn } from "./wake.ts";

type Handle = TcpListenerHandle | UdpListenerHandle;

export type ListenerSet = {
  reconcile(config: ProxyConfig): Promise<void>;
  stopAll(): void;
  size(): number;
};

function keyOf(vip: string, l: ProxyListener): string {
  return `${l.protocol}:${vip}:${l.port}`;
}

export function createListenerSet(wake: WakeFn): ListenerSet {
  const handles = new Map<string, Handle>();

  return {
    async reconcile(config) {
      const desired = new Map<string, { app: ProxyApp; listener: ProxyListener }>();
      for (const app of config.apps) {
        for (const listener of app.listeners) desired.set(keyOf(app.vip, listener), { app, listener });
      }

      for (const [key, handle] of [...handles]) {
        if (desired.has(key)) continue;
        handle.stop();
        handles.delete(key);
        console.log(`[proxy] closed ${key}`);
      }

      for (const [key, { app, listener }] of desired) {
        const existing = handles.get(key);
        if (existing) {
          existing.update(app);
          continue;
        }
        try {
          const handle =
            listener.protocol === "udp"
              ? await openUdpListener(app, listener, wake)
              : openTcpListener(app, listener, wake);
          handles.set(key, handle);
          console.log(`[proxy] opened ${key} → app ${app.appId} (${app.name})`);
        } catch (err) {
          console.error(`[proxy] bind ${key} failed: ${err} — will retry on next reconcile`);
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
  };
}
