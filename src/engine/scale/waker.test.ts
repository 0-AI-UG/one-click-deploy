// Unit tests for the hold-and-forward waker: app resolution, wake coalescing,
// the hold loop, and the HTTP forward path. The forward path runs against an
// in-memory echo server with injected deps (no DB, no containers) so the
// wake-hold-replay behavior is exercised end to end. The wake-secret gate
// tests additionally use the real (temp-dir) DB because
// handleProxyWakeRequest reads the persisted secret directly.
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import { hashAuthPassword } from "../../shared/db/apps.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { tryAcquire, release } from "../scheduler.ts";
import {
  resolveAppByHost,
  sharedWake,
  holdUntilReady,
  handleWakerHttp,
  handleProxyWakeRequest,
  __setWakerDeps,
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

// --- Wake-secret gate on /api/internal/wake (Task-1 pins, DB-backed) ---------

/** Deps for a real DB app row that stays 'sleeping' until wake() is called,
 *  then reports 'running' with the given upstream. Counts wake invocations. */
function wakeableDeps(app: AppRow, counters: { wakes: number }, upstream: string): WakerDeps {
  let woke = false;
  return {
    getApp: (id) => (id === app.id ? { ...app, status: woke ? "running" : "sleeping" } : null),
    getAppByName: (name) => (name === app.name ? app : null),
    getAppByDomain: () => null,
    wake: async (appId) => {
      if (appId === app.id) {
        counters.wakes++;
        woke = true;
      }
      return { ok: true };
    },
    buildUpstreams: () => (woke ? [upstream] : []),
  };
}

function insertRealApp(): AppRow {
  return db.insertApp({
    name: `waker-secret-${randomSuffix()}`,
    domain: "",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
}

function wakeRequest(appId: number, secret?: string): Request {
  return new Request("http://panel.internal:8896/api/internal/wake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "x-ocd-wake-secret": secret } : {}),
    },
    body: JSON.stringify({ appId }),
  });
}

describe("handleProxyWakeRequest (wake-secret gate)", () => {
  test("missing or wrong x-ocd-wake-secret → 401, wake never invoked", async () => {
    db.ensureProxyWakeSecret(); // make sure a non-empty secret exists
    const app = insertRealApp();
    const counters = { wakes: 0 };
    __setWakerDeps(wakeableDeps(app, counters, "10.0.0.9:10001"));
    try {
      const missing = await handleProxyWakeRequest(wakeRequest(app.id));
      expect(missing.status).toBe(401);
      const wrong = await handleProxyWakeRequest(wakeRequest(app.id, "not-the-secret"));
      expect(wrong.status).toBe(401);
      expect(counters.wakes).toBe(0);
    } finally {
      __setWakerDeps(null);
    }
  });

  test("correct secret → wake path invoked, upstream pool returned", async () => {
    const secret = db.ensureProxyWakeSecret();
    const app = insertRealApp();
    const counters = { wakes: 0 };
    __setWakerDeps(wakeableDeps(app, counters, "10.0.0.9:10002"));
    try {
      const res = await handleProxyWakeRequest(wakeRequest(app.id, secret));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, upstreams: ["10.0.0.9:10002"] });
      expect(counters.wakes).toBe(1);
    } finally {
      __setWakerDeps(null);
    }
  });
});

// --- Contract tests (see report): EXPECTED TO FAIL on current main -----------

/** Deps for an in-memory app that sleeps until woken, then serves via the
 *  given upstream port. Returns a probe for whether wake() ever fired. */
function sleepUntilWokenDeps(
  app: AppRow,
  upstreamPort: number | undefined, // Bun.serve().port is number | undefined
): { deps: WakerDeps; wokeYet: () => boolean } {
  let woke = false;
  const deps: WakerDeps = {
    getApp: (id) => (id === app.id ? { ...app, status: woke ? "running" : "sleeping" } : null),
    getAppByName: (name) => (name === app.name ? app : null),
    getAppByDomain: (d) => (d === app.domain ? app : null),
    wake: async () => {
      woke = true;
      return { ok: true };
    },
    buildUpstreams: () => (woke ? [`127.0.0.1:${upstreamPort}`] : []),
  };
  return { deps, wokeYet: () => woke };
}

function startEcho(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      return new Response(`${req.method}:${body}`, { headers: { "x-upstream": "hit" } });
    },
  });
}

describe("contract: P1a Host catch-all enforces per-app basic auth", () => {
  // REGRESSION: currently failing by design — the waker's Host-header
  // catch-all resolves ANY app and wakes+forwards with no auth. Contract:
  // when the resolved app has auth_password_hash set (bcrypt via
  // Bun.password, same hash Traefik's basicAuth middleware consumes with
  // user BASIC_AUTH_USER="admin"), a valid `Authorization: Basic ...` header
  // must be verified BEFORE any wake/forward; otherwise 401 with a
  // WWW-Authenticate: Basic header and NO wake. Apps without a hash keep the
  // open behavior (covered by the passing handleWakerHttp tests above).
  const AUTH_HASH = hashAuthPassword("hunter2");

  function authedApp(): AppRow {
    return fakeApp({
      id: 9101,
      name: "authed",
      domain: "authed.example.com",
      status: "sleeping",
      auth_password_hash: AUTH_HASH,
    });
  }

  const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`;

  test("no Authorization header → 401 + WWW-Authenticate: Basic, and NO wake", async () => {
    const upstream = startEcho();
    try {
      const { deps, wokeYet } = sleepUntilWokenDeps(authedApp(), upstream.port);
      const res = await handleWakerHttp(new Request("http://authed.example.com/"), deps);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate") ?? "").toContain("Basic");
      expect(wokeYet()).toBe(false);
    } finally {
      upstream.stop(true);
    }
  });

  test("wrong password → 401, and NO wake", async () => {
    const upstream = startEcho();
    try {
      const { deps, wokeYet } = sleepUntilWokenDeps(authedApp(), upstream.port);
      const res = await handleWakerHttp(
        new Request("http://authed.example.com/", {
          headers: { authorization: basic("admin", "wrong-password") },
        }),
        deps,
      );
      expect(res.status).toBe(401);
      expect(wokeYet()).toBe(false);
    } finally {
      upstream.stop(true);
    }
  });

  test("valid admin:<password> credentials wake and forward as before", async () => {
    // Guards against over-blocking; passes today too (no auth check at all).
    const upstream = startEcho();
    try {
      const { deps, wokeYet } = sleepUntilWokenDeps(authedApp(), upstream.port);
      const res = await handleWakerHttp(
        new Request("http://authed.example.com/hello", {
          method: "POST",
          headers: { authorization: basic("admin", "hunter2") },
          body: "ping",
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("POST:ping");
      expect(wokeYet()).toBe(true);
    } finally {
      upstream.stop(true);
    }
  });
});

describe("contract: P8 forward path caps buffered request bodies at 10 MiB", () => {
  // REGRESSION: currently failing by design — the waker buffers request
  // bodies of any size and forwards them. Contract: bodies larger than
  // 10 MiB (10 * 1024 * 1024 bytes) get a 413 response without triggering a
  // wake or reaching the upstream.
  test("a body over 10 MiB → 413, no wake, no forward", async () => {
    let upstreamHits = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        upstreamHits++;
        await req.arrayBuffer();
        return new Response("hit");
      },
    });
    try {
      const app = fakeApp({ id: 9102, name: "bigbody", domain: "big.example.com", status: "sleeping" });
      const { deps, wokeYet } = sleepUntilWokenDeps(app, upstream.port);
      const body = new Uint8Array(10 * 1024 * 1024 + 1);
      const res = await handleWakerHttp(
        new Request("http://big.example.com/upload", { method: "POST", body }),
        deps,
      );
      expect(res.status).toBe(413);
      expect(wokeYet()).toBe(false);
      expect(upstreamHits).toBe(0);
    } finally {
      upstream.stop(true);
    }
  }, 20_000);
});

describe("contract: P9 /api/internal/wake is claimed only when the secret header is present", () => {
  // REGRESSION: currently failing by design — handleWakerHttp claims
  // POST /api/internal/wake unconditionally, so an app that itself serves
  // that path can never be reached through the waker. Contract: the internal
  // wake route is taken ONLY when the x-ocd-wake-secret header is present on
  // the request; without it the request falls through to Host-based app
  // resolution and forwarding.
  test("POST /api/internal/wake WITHOUT x-ocd-wake-secret falls through to Host routing", async () => {
    const upstream = startEcho();
    try {
      const app = fakeApp({ id: 9103, name: "wakeish", domain: "wakeish.example.com", status: "running" });
      const deps = depsFor(app, { upstreams: [`127.0.0.1:${upstream.port}`] });
      const res = await handleWakerHttp(
        new Request("http://wakeish.example.com/api/internal/wake", { method: "POST", body: "x" }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("POST:x");
    } finally {
      upstream.stop(true);
    }
  });

  test("WITH the header present the internal route owns the path (bad secret → 401, no forward)", async () => {
    // Anchors the claiming rule — passes today and must keep passing after the fix.
    db.ensureProxyWakeSecret();
    const app = fakeApp({ id: 9104, name: "wakeish2", domain: "wakeish2.example.com", status: "running" });
    const res = await handleWakerHttp(
      new Request("http://wakeish2.example.com/api/internal/wake", {
        method: "POST",
        headers: { "x-ocd-wake-secret": "definitely-wrong" },
        body: JSON.stringify({ appId: app.id }),
      }),
      depsFor(app, { upstreams: ["127.0.0.1:1"] }),
    );
    expect(res.status).toBe(401);
  });
});

describe("contract: P11 wakeWithLock retries a busy app lock (~30s with backoff)", () => {
  // REGRESSION: currently failing by design — wakeWithLock is module-private
  // and refuses immediately when an op holds the app lock. Contract: export
  //   wakeWithLock(appId: number, opts?: {
  //     timeoutMs?: number;      // default 30_000
  //     delayMs?: number;        // default 250 — backoff between attempts
  //     sleep?: (ms: number) => Promise<void>;  // default Bun.sleep
  //     now?: () => number;      // default Date.now
  //   }): Promise<{ ok: boolean; error?: string }>
  // which keeps retrying tryAcquire until the lock frees or timeoutMs of
  // (injected) clock time elapses, then gives up with the busy error.
  test("acquires the lock once the holder releases it during the retry window", async () => {
    const mod: any = await import("./waker.ts");
    expect(typeof mod.wakeWithLock).toBe("function");

    const app = insertRealApp(); // status != 'sleeping' → wakeApp no-ops with ok:true
    const key = `app:${app.id}`;
    tryAcquire([key], 7, "deploy");
    let sleeps = 0;
    const sleep = async (_ms: number) => {
      if (++sleeps >= 3) release([key]);
      if (sleeps > 500) throw new Error("runaway retry loop");
    };
    try {
      const result = await mod.wakeWithLock(app.id, { timeoutMs: 30_000, delayMs: 5, sleep });
      expect(result.ok).toBe(true);
      expect(sleeps).toBeGreaterThanOrEqual(3);
    } finally {
      release([key]);
    }
  });

  test("gives up with the busy error after ~30s of injected clock time", async () => {
    const mod: any = await import("./waker.ts");
    expect(typeof mod.wakeWithLock).toBe("function");

    const app = insertRealApp();
    const key = `app:${app.id}`;
    tryAcquire([key], 7, "deploy");
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
      if (clock > 120_000) throw new Error("runaway retry loop");
    };
    try {
      const result = await mod.wakeWithLock(app.id, { delayMs: 250, sleep, now });
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toContain("busy");
      // Default timeout ~30s of injected time was actually waited out.
      expect(clock).toBeGreaterThanOrEqual(29_000);
      expect(clock).toBeLessThanOrEqual(61_000);
    } finally {
      release([key]);
    }
  });
});
