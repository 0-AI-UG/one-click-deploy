import { handleProxyWakeRequest } from "../../engine/scale/waker.ts";

/**
 * POST /api/internal/wake — fleet-internal wake endpoint for ocd-proxy (see
 * src/proxy/wake.ts for the frozen client contract). The implementation lives
 * in waker.ts because the same handler is also served on the waker's :8896
 * listener — the only panel port published on the private network, and the
 * one the fleet's proxies actually call. This API route is kept for parity
 * and tests.
 */
export async function handleInternalWake(request: Request): Promise<Response> {
  return handleProxyWakeRequest(request);
}
