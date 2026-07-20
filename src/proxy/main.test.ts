// contract: P5 — periodic reconcile timer. Listener reconcile + NAT sync must
// re-run on a timer (default ~60s, injectable for tests) even when the config
// content never changes, so a transiently failed VIP bind or `nft -f` self-heals.
//
// Contract seams the implementation must provide in ./main.ts:
//   export const RECONCILE_INTERVAL_MS = 60_000;
//   runProxy(argv, opts?: { reconcileIntervalMs?: number })  // opts injectable for tests
//     → resolves to { stop(): void } (stops watch + timer + listeners) so tests can clean up.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type MainModule = {
  RECONCILE_INTERVAL_MS?: number;
  runProxy(argv: string[], opts?: { reconcileIntervalMs?: number }): Promise<{ stop(): void } | undefined>;
};

const loadMain = async (): Promise<MainModule> => (await import("./main.ts")) as unknown as MainModule;

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

describe("contract: periodic reconcile self-heal (P5)", () => {
  // REGRESSION: currently failing by design

  test("default reconcile interval constant is 60s", async () => {
    const main = await loadMain();
    expect(main.RECONCILE_INTERVAL_MS).toBe(60_000);
  });

  test("a listener whose bind failed once gets bound on the next timer tick without a config change", async () => {
    const echo = echoServer();
    // Occupy the listen port so the startup bind fails.
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = blocker.port;
    const dir = mkdtempSync(join(tmpdir(), "ocd-proxy-main-"));
    const cfgPath = join(dir, "proxy.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        wakeUrl: null,
        wakeSecret: "",
        listenPort: port,
        apps: [
          {
            appId: 900,
            name: "heal",
            vip: "127.0.0.1",
            frontPorts: [80],
            backends: [`127.0.0.1:${echo.port}`],
            sleeping: false,
          },
        ],
      }),
    );
    const main = await loadMain();
    const handle = await main.runProxy(["--config", cfgPath], { reconcileIntervalMs: 100 });
    try {
      // Startup reconcile ran against the occupied port and failed (non-fatal).
      // Free the port; with NO config change, only the periodic timer can heal it.
      blocker.stop(true);
      await Bun.sleep(600); // several 100ms ticks
      expect(await canConnect(port)).toBe(true);
    } finally {
      handle?.stop?.();
      try {
        blocker.stop(true);
      } catch {
        /* already stopped */
      }
      echo.stop();
    }
  }, 15_000);
});
