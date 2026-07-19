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
});
