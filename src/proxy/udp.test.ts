// UDP data path: datagram echo through the proxy and session reuse for
// subsequent datagrams from the same client address.
import { describe, test, expect } from "bun:test";
import { openUdpListener } from "./udp.ts";
import type { ProxyApp } from "./config.ts";
import type { WakeFn } from "./wake.ts";

function app(over: Partial<ProxyApp> = {}): ProxyApp {
  return {
    appId: 200,
    name: "dns",
    vip: "127.0.0.1",
    frontPorts: [53],
    backends: [],
    sleeping: false,
    ...over,
  };
}

const noWake: WakeFn = async () => {
  throw new Error("wake must not be called");
};

async function udpEchoServer() {
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

describe("udp proxy", () => {
  test("echoes datagrams end-to-end and reuses one session per client", async () => {
    const echo = await udpEchoServer();
    const handle = await openUdpListener(
      app({ backends: [`127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "udp" },
      noWake,
    );
    const replies: string[] = [];
    let notify: (() => void) | null = null;
    const client = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_socket, buf) {
          replies.push(buf.toString());
          notify?.();
        },
      },
    });
    const waitForReplies = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${n} replies`)), 3000);
        notify = () => {
          if (replies.length >= n) {
            clearTimeout(deadline);
            resolve();
          }
        };
        notify();
      });
    try {
      client.send("ping-1", handle.port, "127.0.0.1");
      await waitForReplies(1);
      client.send("ping-2", handle.port, "127.0.0.1");
      await waitForReplies(2);
      expect(replies).toEqual(["ping-1", "ping-2"]);
      expect(handle.sessionCount()).toBe(1); // same client addr:port → one session
    } finally {
      client.close();
      handle.stop();
      echo.close();
    }
  });

  test("sleeping app: wakes once, forwards once backends exist", async () => {
    const echo = await udpEchoServer();
    let wakes = 0;
    const wake: WakeFn = async () => {
      wakes++;
      await Bun.sleep(50);
      return [`127.0.0.1:${echo.port}`];
    };
    const handle = await openUdpListener(
      app({ appId: 201, backends: [], sleeping: true }),
      { port: 0, protocol: "udp" },
      wake,
    );
    const replies: string[] = [];
    const client = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_socket, buf) {
          replies.push(buf.toString());
        },
      },
    });
    try {
      // Dropped while sleeping, but triggers the wake.
      client.send("dropped", handle.port, "127.0.0.1");
      client.send("dropped too", handle.port, "127.0.0.1");
      await Bun.sleep(150);
      client.send("after wake", handle.port, "127.0.0.1");
      const deadline = Date.now() + 3000;
      while (replies.length < 1 && Date.now() < deadline) await Bun.sleep(10);
      expect(replies).toEqual(["after wake"]);
      expect(wakes).toBe(1);
    } finally {
      client.close();
      handle.stop();
      echo.close();
    }
  });
});
