import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, afterEach } from "bun:test";
import * as db from "../../shared/db.ts";
import { __setWakerDeps, type WakerDeps } from "../../engine/scale/waker.ts";
import { handleInternalWake } from "./internal.ts";

function makeApp() {
  return db.insertApp({
    name: `wake-${randomSuffix()}`,
    domain: "x.example.com",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
}

function makeDeps(overrides: Partial<WakerDeps> = {}): WakerDeps {
  return {
    getApp: (id) => db.getApp(id),
    getAppByName: (name) => db.getAppByName(name),
    getAppByDomain: (domain) => db.getAppByDomain(domain),
    wake: async () => ({ ok: true }),
    buildUpstreams: () => [],
    ...overrides,
  };
}

function req(body: unknown, secret?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-ocd-wake-secret"] = secret;
  return new Request("http://localhost/api/internal/wake", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  __setWakerDeps(null);
});

describe("handleInternalWake", () => {
  test("401 when the secret header is missing", async () => {
    const res = await handleInternalWake(req({ appId: 1 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("401 on a wrong secret (same and different length)", async () => {
    const secret = db.ensureProxyWakeSecret();
    const sameLength = secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0");
    for (const bad of [sameLength, "short"]) {
      const res = await handleInternalWake(req({ appId: 1 }, bad));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
  });

  test("400 on malformed JSON", async () => {
    const res = await handleInternalWake(req("not-json", db.ensureProxyWakeSecret()));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("400 on a non-numeric appId", async () => {
    const res = await handleInternalWake(req({ appId: "7" }, db.ensureProxyWakeSecret()));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("404 on an unknown appId", async () => {
    const res = await handleInternalWake(req({ appId: 999999 }, db.ensureProxyWakeSecret()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "App not found" });
  });

  test("already-running app returns its upstreams without waking", async () => {
    const app = makeApp();
    db.updateAppStatus(app.id, "running");
    const wake = mock(async () => ({ ok: true }));
    __setWakerDeps(makeDeps({ wake, buildUpstreams: () => ["10.0.0.5:20005"] }));

    const res = await handleInternalWake(req({ appId: app.id }, db.ensureProxyWakeSecret()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upstreams: ["10.0.0.5:20005"] });
    expect(wake).not.toHaveBeenCalled();
  });

  test("sleeping app: wakes, holds until running, returns fresh upstreams", async () => {
    const app = makeApp();
    db.updateAppStatus(app.id, "sleeping");
    const upstreams: string[] = [];
    const wake = mock(async () => {
      db.updateAppStatus(app.id, "running");
      upstreams.push("10.0.0.9:20017");
      return { ok: true };
    });
    __setWakerDeps(makeDeps({ wake, buildUpstreams: () => upstreams }));

    const res = await handleInternalWake(req({ appId: app.id }, db.ensureProxyWakeSecret()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upstreams: ["10.0.0.9:20017"] });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("wake refusal surfaces as 503 with the wake error", async () => {
    const app = makeApp();
    db.updateAppStatus(app.id, "sleeping");
    __setWakerDeps(makeDeps({
      wake: async () => ({ ok: false, error: "App is busy with another operation (redeploy)" }),
    }));

    const res = await handleInternalWake(req({ appId: app.id }, db.ensureProxyWakeSecret()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "App is busy with another operation (redeploy)",
    });
  });
});
