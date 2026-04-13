import { corsHeaders } from "../lib/cors.ts";
import { authenticateRequest } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import { createDeviceCode, confirmDeviceCode, pollDeviceToken } from "../lib/device-auth.ts";

// POST /api/auth/device-code — called by CLI (no auth)
export function handleDeviceCode(): Response {
  const { deviceCode, userCode, expiresIn } = createDeviceCode();
  return Response.json({ device_code: deviceCode, user_code: userCode, expires_in: expiresIn }, { headers: corsHeaders });
}

// POST /api/auth/device-token — polled by CLI (no auth)
export async function handleDeviceToken(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { device_code?: string };
    if (!body.device_code) {
      return Response.json({ error: "device_code is required" }, { status: 400, headers: corsHeaders });
    }

    const result = pollDeviceToken(body.device_code);

    if (result.status === "complete") {
      return Response.json({ token: result.token }, { headers: corsHeaders });
    }
    if (result.status === "expired") {
      return Response.json({ error: "expired" }, { status: 410, headers: corsHeaders });
    }
    if (result.status === "denied") {
      return Response.json({ error: "denied" }, { status: 403, headers: corsHeaders });
    }

    // Still pending
    return Response.json({ error: "authorization_pending" }, { status: 428, headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

// POST /api/auth/device-confirm — called by web UI (requires auth)
export async function handleDeviceConfirm(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    const body = (await request.json()) as { user_code?: string };

    if (!body.user_code) {
      return Response.json({ error: "user_code is required" }, { status: 400, headers: corsHeaders });
    }

    const result = await confirmDeviceCode(body.user_code, payload);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400, headers: corsHeaders });
    }

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}
