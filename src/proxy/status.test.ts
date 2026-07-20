// contract: P2 — proxy status endpoint and per-app last-activity tracking.
//
// The status module (src/proxy/status.ts) does not exist yet; every test
// lazy-imports it via a computed specifier so today the failure is a contained
// test failure (module-not-found rejection), not a harness crash.
//
// Contract seams the implementation must provide in ./status.ts:
//   export const STATUS_PORT = 18791;                       // default bind port
//   export function recordActivity(appId: number): void;    // called by tcp.ts on every accepted front connection
//   export function getLastActivity(): Record<string, number>; // appId -> epoch ms
//   export function startStatusServer(
//     inputs: { natApplied(): boolean; listenersBound(): number; listenersTotal(): number },
//     port?: number, // injectable for tests (0 = ephemeral); defaults to STATUS_PORT; binds 127.0.0.1 only
//   ): { port: number; stop(): void };
// GET /status responds with JSON:
//   { ok, natApplied, listenersBound, listenersTotal, lastActivity }
// where ok === natApplied && listenersBound === listenersTotal.
import { describe, test, expect } from "bun:test";
import { openTcpListener } from "./tcp.ts";
import type { ProxyApp } from "./config.ts";
import type { WakeFn } from "./wake.ts";

type StatusModule = {
  STATUS_PORT: number;
  recordActivity(appId: number): void;
  getLastActivity(): Record<string, number>;
  startStatusServer(
    inputs: { natApplied(): boolean; listenersBound(): number; listenersTotal(): number },
    port?: number,
  ): { port: number; stop(): void };
};

// Computed specifier: keeps tsc from resolving the not-yet-existing module and
// contains the runtime load failure inside each test.
const loadStatus = (): Promise<StatusModule> => import("./status" + ".ts") as Promise<StatusModule>;

function app(over: Partial<ProxyApp> = {}): ProxyApp {
  return {
    appId: 700,
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

function roundtrip(port: number, payload: string): Promise<string> {
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
          if (received.length >= payload.length) {
            socket.end();
            finish();
          }
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

describe("contract: status endpoint and activity tracking (P2)", () => {
  // REGRESSION: currently failing by design

  test("default status port constant is 18791", async () => {
    const { STATUS_PORT } = await loadStatus();
    expect(STATUS_PORT).toBe(18791);
  });

  test("GET /status returns readiness JSON; ok requires natApplied and all listeners bound", async () => {
    const { startStatusServer } = await loadStatus();
    let nat = true;
    let bound = 2;
    const server = startStatusServer(
      { natApplied: () => nat, listenersBound: () => bound, listenersTotal: () => 2 },
      0, // injectable port so tests never collide with a real proxy
    );
    const get = async (): Promise<Record<string, unknown>> => {
      const res = await fetch(`http://127.0.0.1:${server.port}/status`, { signal: AbortSignal.timeout(3000) });
      return (await res.json()) as Record<string, unknown>;
    };
    try {
      let body = await get();
      expect(body.ok).toBe(true);
      expect(body.natApplied).toBe(true);
      expect(body.listenersBound).toBe(2);
      expect(body.listenersTotal).toBe(2);
      expect(typeof body.lastActivity).toBe("object");

      bound = 1; // a bind failed → not ok
      body = await get();
      expect(body.ok).toBe(false);

      bound = 2;
      nat = false; // nft apply failed → not ok
      body = await get();
      expect(body.ok).toBe(false);
    } finally {
      server.stop();
    }
  }, 10_000);

  test("an accepted front connection records lastActivity for the app", async () => {
    const { getLastActivity } = await loadStatus();
    const echo = echoServer();
    const testApp = app({ appId: 701, backends: [`127.0.0.1:${echo.port}`] });
    const handle = openTcpListener(testApp, { port: 0, protocol: "tcp" }, noWake);
    try {
      const before = Date.now();
      expect(await roundtrip(handle.port, "tick")).toBe("tick");
      const ts = getLastActivity()[String(testApp.appId)];
      expect(typeof ts).toBe("number");
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});
