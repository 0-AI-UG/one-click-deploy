import { getSettings } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { withRetry, isRetryableHttpError } from "../../shared/retry.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

async function apiToken(): Promise<string> {
  const token = await secretStore.get("hetzner_api_token");
  if (token) return token;
  return getSettings().hetzner_api_token ?? "";
}

function friendlyHetznerError(status: number, body: string, method: string, apiPath: string): string {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code;
    const msg = parsed?.error?.message;
    if (code === "uniqueness_error") return `Resource already exists (${msg || "duplicate name"})`;
    if (code === "not_found") return `Resource not found — it may have been deleted`;
    if (code === "forbidden") return "Access denied — check that your API token has the required permissions";
    if (code === "unauthorized") return "Invalid API token — update it in Settings";
    if (code === "rate_limit_exceeded") return "Rate limit exceeded — wait a moment and try again";
    if (code === "conflict") return `Resource conflict: ${msg || "another operation is in progress"}`;
    if (code === "server_limit_exceeded") return "Server limit reached — delete unused servers or request a limit increase from Hetzner";
    if (code === "placement_error") return "No capacity available in this location — try a different datacenter";
    if (msg) return msg;
  } catch { /* body is not JSON — fall through to status-based fallbacks */ }
  if (status === 401) return "Invalid API token — update it in Settings";
  if (status === 403) return "Access denied — check your API token permissions";
  if (status === 404) return `API route not found (${method} ${apiPath})`;
  if (status === 409) return "Resource conflict — another operation may be in progress";
  if (status === 422) return "Invalid request — check your configuration";
  if (status === 429) return "Rate limit exceeded — wait a moment and try again";
  if (status >= 500) return "Hetzner is experiencing issues — try again shortly";
  return `Unexpected error (HTTP ${status})`;
}

export async function hetznerApi(
  apiPath: string,
  options: RequestInit = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const token = await apiToken();
  if (!token) throw new Error("Hetzner API token not configured");
  return withRetry(async () => {
    const method = options.method || "GET";
    log("api", `${method} ${apiPath}`);
    const start = Date.now();
    const res = await fetch(`https://api.hetzner.cloud/v1${apiPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const body = await res.text();
      log("api", `${method} ${apiPath} FAILED ${res.status} in ${elapsed}ms: ${body}`);
      throw new Error(friendlyHetznerError(res.status, body, method, apiPath));
    }
    log("api", `${method} ${apiPath} OK ${res.status} in ${elapsed}ms`);
    return res.json();
  }, { retryOn: isRetryableHttpError });
}

// Public wrapper for hetznerApi (used by RPC handlers for resource listing)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function hetznerApiPublic(apiPath: string, options: RequestInit = {}): Promise<Record<string, any>> {
  return hetznerApi(apiPath, options);
}
