// Wake contract with the panel. When a connection arrives for a sleeping app
// (empty backends) the proxy POSTs to the panel's wake endpoint; the panel
// long-polls internally (up to ~120s) and answers only once the app is awake,
// returning the upstream pool to forward to.

import type { ProxyApp } from "./config.ts";

export type WakeFn = (app: ProxyApp) => Promise<string[]>;

// The panel holds the request up to ~120s while the app cold-starts; give the
// fetch a little headroom beyond that before giving up.
const WAKE_TIMEOUT_MS = 130_000;

type WakeResponse = { ok: true; upstreams: string[] } | { ok: false; error: string };

/** HTTP implementation of the wake contract. Coalesces concurrent wakes per
 *  appId — a burst of connections shares one in-flight request. */
export function httpWake(wakeUrl: string, wakeSecret: string): WakeFn {
  const inFlight = new Map<number, Promise<string[]>>();
  return (app) => {
    let p = inFlight.get(app.appId);
    if (!p) {
      p = doWake(wakeUrl, wakeSecret, app).finally(() => inFlight.delete(app.appId));
      inFlight.set(app.appId, p);
    }
    return p;
  };
}

async function doWake(wakeUrl: string, wakeSecret: string, app: ProxyApp): Promise<string[]> {
  console.log(`[proxy] waking app ${app.appId} (${app.name})`);
  const res = await fetch(wakeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ocd-wake-secret": wakeSecret },
    body: JSON.stringify({ appId: app.appId }),
    signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
  });
  const body = (await res.json()) as WakeResponse;
  if (!body.ok) throw new Error(`wake failed for app ${app.appId}: ${body.error}`);
  if (!Array.isArray(body.upstreams) || body.upstreams.length === 0)
    throw new Error(`wake for app ${app.appId} returned no upstreams`);
  return body.upstreams;
}

// Data-path coalescing, shared across all listeners (TCP and UDP): while a wake
// is in flight for an app, every connection that needs it joins the same
// promise instead of invoking the WakeFn again.
const sharedInFlight = new Map<number, Promise<string[]>>();

export function sharedWake(app: ProxyApp, wake: WakeFn): Promise<string[]> {
  let p = sharedInFlight.get(app.appId);
  if (!p) {
    p = Promise.resolve()
      .then(() => wake(app))
      .finally(() => sharedInFlight.delete(app.appId));
    sharedInFlight.set(app.appId, p);
  }
  return p;
}
