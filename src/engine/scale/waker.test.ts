// Unit tests for the hold-and-forward waker: app resolution, wake coalescing,
// the hold loop, and the HTTP forward path. The forward path runs against an
// in-memory echo server with injected deps (no DB, no containers) so the
// wake-hold-replay behavior is exercised end to end.
import { describe, test, expect } from "bun:test";
import type { AppRow } from "../../shared/db/apps.ts";
import {
  resolveAppByHost,
  sharedWake,
  holdUntilReady,
  handleWakerHttp,
  type WakerDeps,
} from "./waker.ts";

function fakeApp(over: Partial<AppRow>): AppRow {
  return { id: 1, name: "app", domain: "", status: "running", ...over } as AppRow;
}

/** A WakerDeps that resolves one app, with overridable wake + upstreams. */
function depsFor(app: AppRow, opts: { upstreams?: string[]; wake?: WakerDeps["wake"] } = {}): WakerDeps {
  return {
    getApp: (id) => (id === app.id ? app : null),
    getAppByName: (name) => (name === app.name ? app : null),
    getAppByDomain: (domain) => (domain === app.domain ? app : null),
    wake: opts.wake ?? (async () => ({ ok: true })),
    buildUpstreams: () => opts.upstreams ?? [],
  };
}

describe("resolveAppByHost", () => {
  const app = fakeApp({ id: 7, name: "billing", domain: "shop.example.com" });
  const deps = depsFor(app);

  test("internal host resolves by app name under .ocd.internal, ignoring port/case", () => {
    expect(resolveAppByHost("billing.ocd.internal:20005", deps)?.id).toBe(7);
    expect(resolveAppByHost("BILLING.OCD.INTERNAL", deps)?.id).toBe(7);
  });

  test("public host resolves by domain", () => {
    expect(resolveAppByHost("shop.example.com", deps)?.id).toBe(7);
    expect(resolveAppByHost("shop.example.com:443", deps)?.id).toBe(7);
  });

  test("unknown / blank host resolves to null", () => {
    expect(resolveAppByHost("", deps)).toBeNull();
    expect(resolveAppByHost(null, deps)).toBeNull();
    expect(resolveAppByHost("nope.example.com", deps)).toBeNull();
    expect(resolveAppByHost(".ocd.internal", deps)).toBeNull();
  });
});

describe("sharedWake", () => {
  test("coalesces concurrent wakes for the same app into one call", async () => {
    let calls = 0;
    const app = fakeApp({ id: 42 });
    const deps = depsFor(app, {
      wake: async () => {
        calls++;
        await Bun.sleep(20);
        return { ok: true };
      },
    });
    const [a, b, c] = await Promise.all([sharedWake(42, deps), sharedWake(42, deps), sharedWake(42, deps)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(calls).toBe(1);
    // A subsequent wake after the first settled starts a fresh call.
    await sharedWake(42, deps);
    expect(calls).toBe(2);
  });
});

describe("holdUntilReady", () => {
  const noSleep = async () => {};

  test("returns upstreams once the app is running with a pool", async () => {
    let status = "waking";
    const app = fakeApp({ id: 1, status: "waking" });
    const deps: WakerDeps = {
      ...depsFor(app, { upstreams: ["10.0.0.2:10001"] }),
      getApp: () => ({ ...app, status }),
    };
    // Flip to running on the 2nd poll.
    let polls = 0;
    const sleep = async () => {
      if (++polls >= 2) status = "running";
    };
    const ups = await holdUntilReady(1, deps, { pollMs: 1, timeoutMs: 1000, sleep });
    expect(ups).toEqual(["10.0.0.2:10001"]);
  });

  test("returns null when the wake errors (status 'error')", async () => {
    const deps = depsFor(fakeApp({ status: "error" }), { upstreams: ["10.0.0.2:1"] });
    expect(await holdUntilReady(1, deps, { sleep: noSleep })).toBeNull();
  });

  test("returns null on timeout when it never becomes servable", async () => {
    const deps = depsFor(fakeApp({ status: "waking" }), { upstreams: [] });
    expect(await holdUntilReady(1, deps, { pollMs: 1, timeoutMs: 5, sleep: noSleep })).toBeNull();
  });
});

describe("handleWakerHttp", () => {
  test("wakes, holds, then replays the request to the upstream and streams the response", async () => {
    // Echo upstream: reflects method + body + a marker header.
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        return new Response(`${req.method}:${body}`, { headers: { "x-upstream": "hit" } });
      },
    });
    try {
      const app = fakeApp({ id: 3, name: "api", domain: "api.example.com", status: "sleeping" });
      let woke = false;
      // getApp returns sleeping until wake() is called, then running.
      const deps: WakerDeps = {
        getApp: () => ({ ...app, status: woke ? "running" : "sleeping" }),
        getAppByName: () => app,
        getAppByDomain: (d) => (d === app.domain ? app : null),
        wake: async () => {
          woke = true;
          return { ok: true };
        },
        buildUpstreams: () => (woke ? [`127.0.0.1:${upstream.port}`] : []),
      };

      const res = await handleWakerHttp(
        new Request("http://api.example.com/echo", { method: "POST", body: "ping" }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-upstream")).toBe("hit");
      expect(await res.text()).toBe("POST:ping");
      expect(woke).toBe(true);
    } finally {
      upstream.stop(true);
    }
  });

  test("503 JSON for an unknown host (no wake page)", async () => {
    const res = await handleWakerHttp(new Request("http://ghost.example.com/"), depsFor(fakeApp({})));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toBe("app_unavailable");
  });
  // (The "never wakes → 503" timeout path is covered by the holdUntilReady
  // unit test above without waiting the full 120s hold.)
});
