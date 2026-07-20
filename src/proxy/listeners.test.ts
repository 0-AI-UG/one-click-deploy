// Listener-set reconciliation: one TCP listener per app at vip:listenPort.
// Config reloads close removed apps' listeners, open added ones, and keep
// serving on surviving ones. Tests bind 127.0.0.1 with an ephemeral
// listenPort override (PROXY_LISTEN_PORT itself is never bound here).
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

function configFor(apps: ProxyApp[], listenPort: number, publicListenPort?: number): ProxyConfig {
  return { version: 1, wakeUrl: null, wakeSecret: "", listenPort, publicListenPort, apps };
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

function udpEchoServer() {
  return Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, buf, port, addr) {
        socket.send(buf, port, addr);
      },
    },
  });
}

/** Send one datagram to the proxy's public UDP listener, resolve with the echo. */
function udpRoundtrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("udp roundtrip timed out")), 3000);
    void Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, buf) {
          clearTimeout(deadline);
          socket.close();
          resolve(buf.toString());
        },
      },
    }).then((client) => client.send(payload, port, "127.0.0.1"));
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
  test("removed app closes its listener, re-added app starts serving again", async () => {
    const echo = echoServer();
    const port = freePort();
    const set = createListenerSet(noWake);
    try {
      const appA: ProxyApp = {
        appId: 1,
        name: "a",
        vip: "127.0.0.1",
        frontPorts: [80],
        backends: [`127.0.0.1:${echo.port}`],
        sleeping: false,
      };
      await set.reconcile(configFor([appA], port));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "via vip")).toBe("via vip");

      // Reload: app removed → listener closed.
      await set.reconcile(configFor([], port));
      expect(set.size()).toBe(0);
      expect(await canConnect(port)).toBe(false);

      // Reload: app back → listener reopened.
      await set.reconcile(configFor([appA], port));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "back again")).toBe("back again");
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
      frontPorts: [80],
      backends: [`127.0.0.1:${echoOld.port}`],
      sleeping: false,
    };
    try {
      await set.reconcile(configFor([base], port));
      expect(await roundtrip(port, "old pool")).toBe("old pool");

      echoOld.stop();
      await set.reconcile(configFor([{ ...base, backends: [`127.0.0.1:${echoNew.port}`] }], port));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "new pool")).toBe("new pool");
    } finally {
      set.stopAll();
      echoNew.stop();
    }
  });

  test("public-TCP app opens a SECOND listener that serves the app raw (enforceAuth:false), while the internal one fail-closes", async () => {
    const echo = echoServer();
    const internalPort = freePort();
    const publicPort = freePort();
    const set = createListenerSet(noWake);
    const app: ProxyApp = {
      appId: 10,
      name: "raw-tcp",
      vip: "127.0.0.1",
      frontPorts: [80],
      backends: [`127.0.0.1:${echo.port}`],
      sleeping: false,
      authProtected: true, // has a password AND a public raw port — the combo the split listen ports exist for
      publicPort: 30040,
      publicProtocol: "tcp",
    };
    try {
      await set.reconcile(configFor([app], internalPort, publicPort));
      expect(set.size()).toBe(2); // internal-tcp + public-tcp
      // Public listener: auth-free raw pass-through.
      expect(await roundtrip(publicPort, "raw and open")).toBe("raw and open");
      // Internal listener: fail-closes the same app (no echo).
      expect(await roundtrip(internalPort, "blocked")).toBe("");
    } finally {
      set.stopAll();
      echo.stop();
    }
  });

  test("public-UDP app opens a UDP listener alongside the internal TCP one", async () => {
    const echo = await udpEchoServer();
    const internalPort = freePort();
    const publicPort = freePort();
    const set = createListenerSet(noWake);
    const app: ProxyApp = {
      appId: 11,
      name: "raw-udp",
      vip: "127.0.0.1",
      frontPorts: [53],
      backends: [`127.0.0.1:${echo.port}`],
      sleeping: false,
      publicPort: 30090,
      publicProtocol: "udp",
    };
    try {
      await set.reconcile(configFor([app], internalPort, publicPort));
      expect(set.size()).toBe(2); // internal-tcp + public-udp
      expect(await udpRoundtrip(publicPort, "datagram")).toBe("datagram");
    } finally {
      set.stopAll();
      echo.close();
    }
  });

  test("internal-only app opens exactly one listener (no public port)", async () => {
    const echo = echoServer();
    const set = createListenerSet(noWake);
    const port = freePort();
    const app: ProxyApp = {
      appId: 12,
      name: "internal",
      vip: "127.0.0.1",
      frontPorts: [80],
      backends: [`127.0.0.1:${echo.port}`],
      sleeping: false,
    };
    try {
      await set.reconcile(configFor([app], port));
      expect(set.size()).toBe(1);
    } finally {
      set.stopAll();
      echo.stop();
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
      frontPorts: [80],
      backends: [`127.0.0.1:${echo.port}`],
      sleeping: false,
    };
    try {
      await set.reconcile(configFor([appC], port));
      expect(set.size()).toBe(0); // bind failed, process alive

      blocker.stop(true);
      await set.reconcile(configFor([appC], port));
      expect(set.size()).toBe(1);
      expect(await roundtrip(port, "retried")).toBe("retried");
    } finally {
      set.stopAll();
      echo.stop();
    }
  });
});
