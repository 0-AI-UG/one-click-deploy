import { timingSafeEqual } from "node:crypto";
import { corsHeaders } from "../lib/cors.ts";
import * as db from "../../shared/db.ts";
import { wakeUpstreamsForProxy } from "../../engine/scale/waker.ts";

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/internal/wake — fleet-internal wake endpoint for ocd-proxy (see
 * src/proxy/wake.ts for the frozen client contract). Authenticated by the
 * shared proxy_wake_secret over the private network — no user token, matching
 * how webhooks self-authenticate. Long-polls (up to ~120s) until the app is
 * running with a real upstream pool, then answers { ok, upstreams }.
 */
export async function handleInternalWake(request: Request): Promise<Response> {
  const presented = request.headers.get("x-ocd-wake-secret");
  if (!presented || !secretMatches(presented, db.ensureProxyWakeSecret())) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  let appId: unknown;
  try {
    appId = ((await request.json()) as { appId?: unknown })?.appId;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }
  if (typeof appId !== "number" || !Number.isInteger(appId)) {
    return Response.json({ ok: false, error: "appId must be a number" }, { status: 400, headers: corsHeaders });
  }
  if (!db.getApp(appId)) {
    return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
  }

  const result = await wakeUpstreamsForProxy(appId);
  return Response.json(result, { status: result.ok ? 200 : 503, headers: corsHeaders });
}
