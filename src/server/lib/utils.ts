import { corsHeaders } from "./cors.ts";

export function handleError(error: unknown): Response {
  if (error instanceof Error) {
    const name = error.constructor.name;
    if (name === "BadRequestError") {
      return Response.json({ error: error.message }, { status: 400, headers: corsHeaders });
    }
    if (name === "AuthError") {
      return Response.json({ error: error.message }, { status: 401, headers: corsHeaders });
    }
    if (name === "ForbiddenError") {
      return Response.json({ error: error.message }, { status: 403, headers: corsHeaders });
    }
    if (name === "PermissionError") {
      return Response.json({ error: error.message }, { status: 403, headers: corsHeaders });
    }
  }
  console.error("[server] unhandled error:", error);
  return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
}

/**
 * Returns the client's IP address.
 *
 * Priority:
 * 1. Bun's built-in requestIP (not spoofable) when a server instance is passed.
 * 2. X-Forwarded-For / X-Real-IP only when TRUST_PROXY=1 (or "true") is set.
 * 3. null — callers decide what to do when no IP is resolvable.
 */
export function getClientIP(
  request: Request,
  server?: { requestIP(req: Request): { address: string } | null },
): string | null {
  // Primary: use Bun's built-in IP resolution (not spoofable)
  if (server) {
    const addr = server.requestIP(request)?.address;
    if (addr) return addr;
  }

  // Fallback: trust proxy headers only when explicitly opted in
  if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp;
  }

  return null;
}

export function extractPathParam(url: string, prefix: string): string {
  const path = new URL(url).pathname;
  const rest = path.slice(prefix.length);
  // Get the next segment after prefix
  const parts = rest.split("/").filter(Boolean);
  return parts[0] || "";
}
