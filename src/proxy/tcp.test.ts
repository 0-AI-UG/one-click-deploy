// TCP data path: echo end-to-end, connect-retry failover, wake-hold with
// buffered opening bytes, and wake coalescing. Everything runs on 127.0.0.1
// with ephemeral ports and fake WakeFns — no panel, no containers.
import { describe, test, expect } from "bun:test";
import { openTcpListener } from "./tcp.ts";
import type { ProxyApp } from "./config.ts";
import type { WakeFn } from "./wake.ts";

let nextAppId = 100;

function app(over: Partial<ProxyApp> = {}): ProxyApp {
  return {
    appId: nextAppId++,
    name: "web",
    vip: "127.0.0.1",
    frontPorts: [80],
    backends: [],
    sleeping: false,
    ...over,
  };
}

const noWake: WakeFn = async () => {
  throw new Error("wake must not be called");
};

function echoServer(): { port: number; received: Buffer[]; stop(): void } {
  const received: Buffer[] = [];
  const listener = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        received.push(Buffer.from(chunk));
        socket.write(chunk);
      },
    },
  });
  return { port: listener.port, received, stop: () => listener.stop(true) };
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** Connect, write payload, resolve with everything received back once at least
 *  `expectBytes` arrived (or the peer closed). */
function roundtrip(port: number, payload: string, expectBytes = payload.length): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(received);
      }
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          received += chunk.toString();
          if (received.length >= expectBytes) {
            socket.end();
            finish();
          }
        },
        close: finish,
        error(_socket, err) {
          if (!done) reject(err);
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

describe("tcp proxy", () => {
  test("echoes end-to-end through the proxy", async () => {
    const echo = echoServer();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
      noWake,
    );
    try {
      expect(await roundtrip(handle.port, "hello through the vip")).toBe("hello through the vip");
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("fails over to a live backend when the first pick is dead", async () => {
    const echo = echoServer();
    const dead = freePort();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${dead}`, `127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
      noWake,
    );
    try {
      // Random pick order: several roundtrips so the dead-first path is taken.
      for (let i = 0; i < 4; i++) {
        expect(await roundtrip(handle.port, `attempt ${i}`)).toBe(`attempt ${i}`);
      }
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("wake-hold: bytes sent before the wake completes reach the backend intact", async () => {
    const echo = echoServer();
    let wakes = 0;
    const wake: WakeFn = async () => {
      wakes++;
      await Bun.sleep(100);
      return [`127.0.0.1:${echo.port}`];
    };
    const handle = openTcpListener(app({ backends: [], sleeping: true }), { port: 0, protocol: "tcp" }, wake);
    try {
      // The client writes immediately on open — before the wake resolves.
      expect(await roundtrip(handle.port, "early bytes")).toBe("early bytes");
      expect(wakes).toBe(1);
      expect(Buffer.concat(echo.received).toString()).toBe("early bytes");
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("coalesces concurrent wakes into one WakeFn call", async () => {
    const echo = echoServer();
    let wakes = 0;
    const wake: WakeFn = async () => {
      wakes++;
      await Bun.sleep(80);
      return [`127.0.0.1:${echo.port}`];
    };
    const handle = openTcpListener(app({ backends: [], sleeping: true }), { port: 0, protocol: "tcp" }, wake);
    try {
      const [a, b] = await Promise.all([roundtrip(handle.port, "first"), roundtrip(handle.port, "second")]);
      expect(a).toBe("first");
      expect(b).toBe("second");
      expect(wakes).toBe(1);
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("closes the client when the wake fails", async () => {
    const wake: WakeFn = async () => {
      throw new Error("panel says no");
    };
    const handle = openTcpListener(app({ backends: [], sleeping: true }), { port: 0, protocol: "tcp" }, wake);
    try {
      // Resolves with whatever arrived (nothing) once the proxy closes us.
      expect(await roundtrip(handle.port, "doomed", 1)).toBe("");
    } finally {
      handle.stop();
    }
  });

  test("retries past several refused backends to reach the live one", async () => {
    // Deterministic regardless of the random pick order: two dead, one live.
    const echo = echoServer();
    const dead1 = freePort();
    const dead2 = freePort();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${dead1}`, `127.0.0.1:${dead2}`, `127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
      noWake,
    );
    try {
      expect(await roundtrip(handle.port, "past the dead")).toBe("past the dead");
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);

  test("empty backends triggers the wake path even when sleeping is false", async () => {
    // Wake is keyed on an empty pool, not on the sleeping flag: a wake-capable
    // app with no backends always goes through the wake path.
    const echo = echoServer();
    let wakes = 0;
    const wake: WakeFn = async () => {
      wakes++;
      return [`127.0.0.1:${echo.port}`];
    };
    const handle = openTcpListener(app({ backends: [], sleeping: false }), { port: 0, protocol: "tcp" }, wake);
    try {
      expect(await roundtrip(handle.port, "empty pool")).toBe("empty pool");
      expect(wakes).toBe(1);
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});

/** Like roundtrip, but resolves with everything received on close OR error —
 *  contract tests expect the proxy to destroy the connection, which can
 *  surface client-side as ECONNRESET rather than a clean FIN. */
function probeUntilClose(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(received);
      }
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          received += chunk.toString();
          socket.end();
          finish();
        },
        close: finish,
        error: finish,
        connectError(_socket, err) {
          if (!done) {
            done = true;
            reject(err);
          }
        },
      },
    }).catch((err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

describe("contract: authProtected connections are refused at the TCP layer (P1b)", () => {
  // REGRESSION: currently failing by design
  test("destroys an accepted connection for an authProtected app without dialing the backend", async () => {
    const echo = echoServer();
    // Contract seam: ProxyApp gains `authProtected?: boolean`.
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" }, noWake);
    try {
      const got = await probeUntilClose(handle.port, "must not pass");
      expect(got).toBe(""); // no echo — the proxy destroyed us before proxying
      expect(Buffer.concat(echo.received).length).toBe(0); // and never dialed the backend
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});

describe("public listener: enforceAuth=false serves auth-protected apps raw", () => {
  test("an authProtected app still echoes through a public (enforceAuth:false) listener", async () => {
    const echo = echoServer();
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" }, noWake, { enforceAuth: false });
    try {
      // Public raw exposure is deliberately auth-free — the fail-close is skipped.
      expect(await roundtrip(handle.port, "raw and open")).toBe("raw and open");
      expect(Buffer.concat(echo.received).toString()).toBe("raw and open");
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("the internal listener (default enforceAuth) still fail-closes the same app", async () => {
    const echo = echoServer();
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" }, noWake);
    try {
      expect(await probeUntilClose(handle.port, "must not pass")).toBe("");
      expect(Buffer.concat(echo.received).length).toBe(0);
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});

describe("contract: wake fallback when all backends refuse (P3b)", () => {
  // REGRESSION: currently failing by design
  test("all-refused dial falls back to the wake path and connects to the refreshed pool", async () => {
    const echo = echoServer();
    const dead = freePort();
    let wakes = 0;
    const wake: WakeFn = async () => {
      wakes++;
      return [`127.0.0.1:${echo.port}`];
    };
    // Backends configured but stale (all refuse): instead of tearing down, the
    // proxy must buffer + wake and then use the refreshed pool.
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${dead}`], sleeping: false }),
      { port: 0, protocol: "tcp" },
      wake,
    );
    try {
      expect(await roundtrip(handle.port, "revive me")).toBe("revive me");
      expect(wakes).toBe(1);
      expect(Buffer.concat(echo.received).toString()).toBe("revive me");
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});
