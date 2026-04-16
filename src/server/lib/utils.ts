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

export function getClientIP(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export function extractPathParam(url: string, prefix: string): string {
  const path = new URL(url).pathname;
  const rest = path.slice(prefix.length);
  // Get the next segment after prefix
  const parts = rest.split("/").filter(Boolean);
  return parts[0] || "";
}
