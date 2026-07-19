// Listener-set reconciliation: config reloads close removed listeners, open
// added ones, and keep serving on surviving ones.
import { describe, test, expect } from "bun:test";
import { createListenerSet } from "./listeners.ts";
import type { ProxyApp, ProxyConfig } from "./config.ts";
import type { WakeFn } from "./wake.ts";

const noWake: WakeFn = async () => {
  throw new Error("wake must not be called");
};

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function echoServer(): { port: number; stop(): void } {
  const listener = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(chunk);
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
}

function configFor(apps: ProxyApp[]): ProxyConfig {
  return { version: 1, wakeUrl: null, wakeSecret: "", apps };
}

function roundtrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let done = false;
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          received += chunk.toString();
          if (received.length >= payload.length) {
            socket.end();
            if (!done) {
              done = true;
              resolve(received);
            }
          }
        },
        close() {
          if (!done) {
            done = true;
            resolve(received);
          }
        },
        connectError(_socket, err) {
          if (!done) reject(err);
        },
      },
    }).catch((err) => {
      if (!done) reject(err);
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, connectError() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

describe("listener reconciliation", () => {
  test("removed listener closes its port, added listener starts serving", async () => {
    const echo = echoServer();
    const backend = [`127.0.0.1:${echo.port}`];
    const portA = freePort();
    const portB = freePort();
    const set = createListenerSet(noWake);
    try {
      const appA: ProxyApp = {
        appId: 1,
        name: "a",
        vip: "127.0.0.1",
        listeners: [{ port: portA, protocol: "tcp" }],
        backends: backend,
        sleeping: false,
      };
      await set.reconcile(configFor([appA]));
      expect(set.size()).toBe(1);
      expect(await roundtrip(portA, "via portA")).toBe("via portA");

      // Reload: portA listener removed, portB listener added.
      await set.reconcile(configFor([{ ...appA, listeners: [{ port: portB, protocol: "tcp" }] }]));
      expect(set.size()).toBe(1);
      expect(await canConnect(portA)).toBe(false);
      expect(await roundtrip(portB, "via portB")).toBe("via portB");
    } finally {
      set.stopAll();
      echo.stop();
    }
  });

  test("surviving listener picks up new backends for new connections", async () => {
    const echoOld = echoServer();
    const echoNew = echoServer();
    const port = freePort();
    const set = createListenerSet(noWake);
    const base: ProxyApp = {
      appId: 2,
      name: "b",
      vip: "127.0.0.1",
      listeners: [{ port, protocol: "tcp" }],
      backends: [`127.0.0.1:${echoOld.port}`],
      sleeping: false,
    };
    try {
      await set.reconcile(configFor([base]));
      expect(await roundtrip(port, "old pool")).toBe("old pool");

      echoOld.stop();
      await set.reconcile(configFor([{ ...base, backends: [`127.0.0.1:${echoNew.port}`] }]));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "new pool")).toBe("new pool");
    } finally {
      set.stopAll();
      echoNew.stop();
    }
  });

  test("bind failure is non-fatal and retried on the next reconcile", async () => {
    const echo = echoServer();
    const set = createListenerSet(noWake);
    // Occupy a port so the bind fails, then free it.
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = blocker.port;
    const appC: ProxyApp = {
      appId: 3,
      name: "c",
      vip: "127.0.0.1",
      listeners: [{ port, protocol: "tcp" }],
      backends: [`127.0.0.1:${echo.port}`],
      sleeping: false,
    };
    try {
      await set.reconcile(configFor([appC]));
      expect(set.size()).toBe(0); // bind failed, process alive

      blocker.stop(true);
      await set.reconcile(configFor([appC]));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "retried")).toBe("retried");
    } finally {
      set.stopAll();
      echo.stop();
    }
  });
});
