import { getSettings } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { withRetry, isRetryableHttpError } from "../../shared/retry.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [do:${context}]`, ...args);
}

async function apiToken(): Promise<string> {
  const token = await secretStore.get("digitalocean_api_token");
  if (token) return token;
  return getSettings().digitalocean_api_token ?? "";
}

function friendlyDoError(status: number, body: string, method: string, apiPath: string): string {
  try {
    const parsed = JSON.parse(body);
    const id = parsed?.id;
    const msg = parsed?.message;
    if (id === "unauthorized") return "Invalid API token — update it in Settings";
    if (id === "forbidden") return "Access denied — check that your API token has the required scopes";
    if (id === "not_found") return "Resource not found — it may have been deleted";
    if (id === "too_many_requests" || id === "rate_limit") return "Rate limit exceeded — wait a moment and try again";
    if (id === "conflict") return `Resource conflict: ${msg || "another operation is in progress"}`;
    if (id === "unprocessable_entity" || id === "validation_failed") return msg || "Invalid request — check your configuration";
    if (msg) return msg;
  } catch { /* body is not JSON */ }
  if (status === 401) return "Invalid API token — update it in Settings";
  if (status === 403) return "Access denied — check your API token scopes";
  if (status === 404) return `API route not found (${method} ${apiPath})`;
  if (status === 409) return "Resource conflict — another operation may be in progress";
  if (status === 422) return "Invalid request — check your configuration";
  if (status === 429) return "Rate limit exceeded — wait a moment and try again";
  if (status >= 500) return "DigitalOcean is experiencing issues — try again shortly";
  return `Unexpected error (HTTP ${status})`;
}

export async function doApi(
  apiPath: string,
  options: RequestInit = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const token = await apiToken();
  if (!token) throw new Error("DigitalOcean API token not configured");
  return withRetry(async () => {
    const method = options.method || "GET";
    log("api", `${method} ${apiPath}`);
    const start = Date.now();
    const res = await fetch(`https://api.digitalocean.com/v2${apiPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const elapsed = Date.now() - start;
    // 204 No Content (delete) returns no body
    if (res.status === 204) {
      log("api", `${method} ${apiPath} OK 204 in ${elapsed}ms`);
      return {};
    }
    if (!res.ok) {
      const body = await res.text();
      log("api", `${method} ${apiPath} FAILED ${res.status} in ${elapsed}ms: ${body}`);
      throw new Error(friendlyDoError(res.status, body, method, apiPath));
    }
    log("api", `${method} ${apiPath} OK ${res.status} in ${elapsed}ms`);
    return res.json();
  }, { retryOn: isRetryableHttpError });
}

/** Poll a DO action until completed or errored. */
export async function pollDoAction(
  actionId: number | string,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const interval = opts?.intervalMs ?? 2000;
  const timeout = opts?.timeoutMs ?? 60000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = await doApi(`/actions/${actionId}`) as { action: { status: string } };
    const status = data.action?.status;
    if (status === "completed") return;
    if (status === "errored") throw new Error(`DigitalOcean action ${actionId} failed`);
    await Bun.sleep(interval);
  }
  throw new Error("Operation timed out — DigitalOcean took too long to respond. Try again.");
}
