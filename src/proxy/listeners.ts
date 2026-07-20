// Reconcile the running listener set against a ProxyConfig. Each app gets one
// INTERNAL TCP listener at vip:listenPort (the user-facing front ports are
// DNATed to it by nat.ts, never bound). A raw-exposed app additionally gets a
// PUBLIC listener at vip:publicListenPort — TCP or UDP per publicProtocol —
// carrying the 30000-30099 pool DNATed off the panel's public IP. The internal
// listener fail-closes password-protected apps; the public one does not (raw
// exposure is auth-free), which is exactly why the two paths need separate
// listen ports (after DNAT the original port is gone).
//
// Diff by `vip#role` — close removed listeners, open added ones, and swap each
// surviving listener's app snapshot in place (backends/sleeping changes apply
// to new connections only). Bind failures are logged, never fatal; the key
// stays absent so the next reconcile retries it.

import {
  PROXY_LISTEN_PORT,
  PROXY_PUBLIC_LISTEN_PORT,
  type ProxyApp,
  type ProxyConfig,
} from "./config.ts";
import { openTcpListener } from "./tcp.ts";
import { openUdpListener } from "./udp.ts";
import type { WakeFn } from "./wake.ts";

/** Common shape of a TCP or UDP listener handle — all reconcile needs. */
type ListenerHandle = {
  port: number;
  update(app: ProxyApp): void;
  stop(): void;
};

type Role = "internal-tcp" | "public-tcp" | "public-udp";

export type ListenerSet = {
  reconcile(config: ProxyConfig): Promise<void>;
  stopAll(): void;
  size(): number;
  /** Listeners the last reconciled config asked for (bound or not) — status uses size()/desiredSize() as bound/total. */
  desiredSize(): number;
};

/** The listeners one app wants, keyed by `vip#role`. Every app wants an internal
 *  TCP listener; a raw-exposed app additionally wants one public listener. */
function desiredForApp(app: ProxyApp): Array<{ key: string; role: Role }> {
  const out: Array<{ key: string; role: Role }> = [{ key: `${app.vip}#internal-tcp`, role: "internal-tcp" }];
  if (app.publicPort != null) {
    const role: Role = app.publicProtocol === "udp" ? "public-udp" : "public-tcp";
    out.push({ key: `${app.vip}#${role}`, role });
  }
  return out;
}

export function createListenerSet(wake: WakeFn): ListenerSet {
  const handles = new Map<string, ListenerHandle>();
  let desiredCount = 0;

  async function open(role: Role, app: ProxyApp, internalPort: number, publicPort: number): Promise<ListenerHandle> {
    switch (role) {
      case "internal-tcp":
        return openTcpListener(app, { port: internalPort, protocol: "tcp" }, wake);
      case "public-tcp":
        return openTcpListener(app, { port: publicPort, protocol: "tcp" }, wake, { enforceAuth: false });
      case "public-udp":
        return openUdpListener(app, { port: publicPort, protocol: "udp" }, wake);
    }
  }

  return {
    async reconcile(config) {
      const internalPort = config.listenPort ?? PROXY_LISTEN_PORT;
      const publicPort = config.publicListenPort ?? PROXY_PUBLIC_LISTEN_PORT;
      const desired = new Map<string, { role: Role; app: ProxyApp }>();
      for (const app of config.apps) {
        for (const { key, role } of desiredForApp(app)) desired.set(key, { role, app });
      }
      desiredCount = desired.size;

      for (const [key, handle] of [...handles]) {
        if (desired.has(key)) continue;
        handle.stop();
        handles.delete(key);
        console.log(`[proxy] closed ${key}:${handle.port}`);
      }

      for (const [key, { role, app }] of desired) {
        const existing = handles.get(key);
        if (existing) {
          existing.update(app);
          continue;
        }
        try {
          const handle = await open(role, app, internalPort, publicPort);
          handles.set(key, handle);
          console.log(`[proxy] opened ${key}:${handle.port} → app ${app.appId} (${app.name})`);
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
    desiredSize() {
      return desiredCount;
    },
  };
}
