import { requireConfig } from "./config.ts";
import { VERSION } from "./version.ts";
import { DIM, RESET, YELLOW } from "./format.ts";
import { expectArray, expectRecord } from "./response.ts";

// Warn at most once per process when the backend reports a different version
// than this CLI, so a stale CLI (issue: version drift was invisible) is
// obvious without nagging on every request.
let versionWarned = false;
function checkBackendVersion(res: Response): void {
  if (versionWarned) return;
  const backend = res.headers.get("X-OCD-Version");
  // "dev" = running from source; nothing meaningful to compare.
  if (!backend || VERSION === "dev" || backend === "dev" || backend === VERSION) return;
  versionWarned = true;
  console.error(
    `${YELLOW}⚠ ocd CLI v${VERSION} differs from the panel (v${backend}).${RESET} ` +
      `${DIM}Reinstall the CLI from your panel to update.${RESET}`,
  );
}

/** Shown whenever the panel refuses a CLI token for want of `cli.access`. */
export const CLI_ACCESS_DENIED_MESSAGE =
  `${YELLOW}This account is not allowed to use the ocd CLI.${RESET} ` +
  `${DIM}Ask an admin to grant it the "cli.access" permission.${RESET}`;

/** Does this server error message mean "your account may not use the CLI"?
 *  Matched on the message because the panel returns a plain 403 with no code. */
export function isCliAccessDenied(serverError: string | undefined | null): boolean {
  return !!serverError && /cli access/i.test(serverError);
}

export async function get<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

export async function post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  return apiRequest<T>("POST", path, body, headers);
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("PUT", path, body);
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("PATCH", path, body);
}

export async function del<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  return apiRequest<T>("DELETE", path, body, headers);
}

/**
 * An HTTP/transport failure talking to the panel. Carries the request context
 * and status so callers can surface a useful message and decide whether to
 * retry. `status` is 0 for a transport-level failure (DNS/connection reset).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    message: string,
    public readonly transportKind?: PanelTransportFailureKind,
    public readonly responseBody?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Transient gateway / network conditions worth retrying a poll through. */
  get isTransient(): boolean {
    return (
      (this.status === 0 && this.method === "GET" &&
        this.transportKind !== "certificate_validation" && this.transportKind !== "local_trust_store") ||
      this.status === 502 || this.status === 503 || this.status === 504
    );
  }
}

export type PanelTransportFailureKind =
  | "unknown_certificate_verification"
  | "certificate_validation"
  | "local_trust_store"
  | "tls_transport_reset"
  | "panel_unavailable"
  | "dns_failure"
  | "timeout"
  | "transport_failure";

export function shouldRetryPanelTransport(method: string, kind: PanelTransportFailureKind): boolean {
  if (method !== "GET") return false;
  return kind !== "certificate_validation" && kind !== "local_trust_store";
}

function errorChain(err: unknown): { text: string; codes: string[] } {
  const texts: string[] = [];
  const codes: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) texts.push(current.message);
    else texts.push(String(current));
    if (typeof current === "object") {
      const row = current as { code?: unknown; cause?: unknown };
      if (row.code) codes.push(String(row.code));
      current = row.cause;
    } else break;
  }
  return { text: texts.filter(Boolean).join(": "), codes };
}

/** Classify Bun/fetch transport errors without collapsing TLS trust failures
 * into the same message as an unavailable panel. */
export function describePanelTransportError(
  err: unknown,
  panelUrl: string,
): { kind: PanelTransportFailureKind; message: string } {
  const chain = errorChain(err);
  const raw = `${chain.text} ${chain.codes.join(" ")}`.trim();
  const lower = raw.toLowerCase();
  const code = chain.codes[0] ? ` [${chain.codes.join(" → ")}]` : "";
  let kind: PanelTransportFailureKind;
  let label: string;
  if (/unknown certificate verification/.test(lower)) {
    // Bun has intermittently emitted this generic error for a request that
    // succeeds immediately on a fresh connection. It contains no durable
    // certificate diagnosis, so idempotent GET callers may retry it. More
    // specific trust/hostname/expiry failures below remain permanent.
    kind = "unknown_certificate_verification";
    label = "certificate verification failed for an unknown reason";
  } else if (/unable_to_get_issuer_cert_locally|cert_untrusted|local issuer/.test(lower)) {
    kind = "local_trust_store";
    label = "local trust store could not build a trusted certificate chain";
  } else if (/certificate|self[_ -]?signed|unable_to_verify_leaf|cert_has_expired|hostname.*match/.test(lower)) {
    kind = "certificate_validation";
    label = "TLS certificate validation failed";
  } else if (/connection reset|econnreset|tls.*(reset|closed)|socket.*closed|unexpected eof|handshake/.test(lower)) {
    kind = "tls_transport_reset";
    label = "TLS transport was reset during connection/handshake";
  } else if (/enotfound|eai_again|name or service not known|dns/.test(lower)) {
    kind = "dns_failure";
    label = "panel hostname could not be resolved";
  } else if (/timeout|timed out|abort/.test(lower)) {
    kind = "timeout";
    label = "panel request timed out";
  } else if (/econnrefused|connection refused|host unreachable|network unreachable/.test(lower)) {
    kind = "panel_unavailable";
    label = "panel is unavailable or refusing connections";
  } else {
    kind = "transport_failure";
    label = "panel transport failed";
  }
  let chainHint = "";
  if (kind === "unknown_certificate_verification" || kind === "certificate_validation" || kind === "local_trust_store") {
    try {
      const url = new URL(panelUrl);
      const port = url.port || "443";
      chainHint =
        `; inspect the served chain with: openssl s_client -showcerts ` +
        `-connect ${url.hostname}:${port} -servername ${url.hostname}`;
    } catch { /* retain classification without a command hint */ }
  }
  return { kind, message: `${label}${code}: ${chain.text || String(err)}${chainHint}` };
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const config = requireConfig();
  const url = `${config.panel_url}${path}`;

  let res: Response | undefined;
  let lastTransport: ReturnType<typeof describePanelTransportError> | undefined;
  // GETs are safe to replay and comprise operation streams/status polling.
  // Keep POST/PUT/PATCH/DELETE single-shot so a dropped response cannot create
  // duplicate side effects (their operation IDs remain recoverable server-side).
  const attempts = method === "GET" ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers: {
          "Authorization": `Bearer ${config.token}`,
          // GETs are replayable and use a fresh transport connection. This
          // avoids repeatedly selecting a stale pooled TLS connection when
          // Bun reports its intermittent unknown verification failure.
          "Connection": method === "GET" ? "close" : "keep-alive",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(headers || {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      lastTransport = describePanelTransportError(err, config.panel_url);
      const retryable = shouldRetryPanelTransport(method, lastTransport.kind);
      if (!retryable || attempt === attempts) break;
      await Bun.sleep(250 * 2 ** (attempt - 1));
    }
  }
  if (!res) {
    const detail = lastTransport ?? describePanelTransportError("unknown transport failure", config.panel_url);
    throw new ApiError(0, method, path, `${method} ${path} — ${detail.message}`, detail.kind);
  }

  checkBackendVersion(res);

  if (res.status === 401) {
    console.error("Session expired. Run `ocd login` again.");
    process.exit(1);
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ({ error?: string } & Record<string, unknown>) | null;

    // The server rejects every CLI-minted token whose user lacks `cli.access`.
    // That is an account-configuration problem, not a bad request, so print the
    // fix instead of an HTTP dump the user can do nothing with.
    if (res.status === 403 && isCliAccessDenied(err?.error)) {
      console.error(CLI_ACCESS_DENIED_MESSAGE);
      process.exit(1);
    }

    const server = err?.error ? `: ${err.error}` : "";
    throw new ApiError(
      res.status,
      method,
      path,
      `${method} ${path} → HTTP ${res.status} ${res.statusText}${server}`,
      undefined,
      err ?? undefined,
    );
  }

  return res.json() as Promise<T>;
}

export interface App {
  id: number;
  name: string;
  status: string;
  domain: string;
  git_repo: string;
  desired_replicas: number;
  servers: number[];
  created_at: string;
  public?: boolean | number;
  container_port?: number;
  internal_protocol?: string;
  deployed_commit?: string | null;
  environment_stale?: boolean | number;
}

/** Where the app answers: its public domain, or the canonical internal
 *  address for private apps (which have no public ingress at all). HTTP apps
 *  are port-less behind the per-app VIP proxy; TCP apps use their own
 *  container port. */
export function appAddress(app: {
  name: string;
  domain: string;
  public?: boolean | number;
  container_port?: number;
  internal_protocol?: string;
}): string {
  if (app.public === false || app.public === 0) {
    if (app.internal_protocol === "tcp") {
      return `tcp://${app.name}.ocd.internal:${app.container_port} (private)`;
    }
    return `http://${app.name}.ocd.internal (private)`;
  }
  return app.domain || "-";
}

let cachedApps: App[] | null = null;

export async function getApps(): Promise<App[]> {
  if (!cachedApps) {
    const payload = await get<unknown>("/api/apps");
    const rows = expectArray(payload, "Apps request");
    for (const [index, value] of rows.entries()) {
      const row = expectRecord(value, `Apps request item ${index + 1}`);
      if (!Number.isInteger(row.id) || typeof row.name !== "string" || typeof row.status !== "string") {
        throw new Error(`Apps request returned a malformed response (invalid app at index ${index})`);
      }
    }
    cachedApps = rows as App[];
  }
  return cachedApps;
}

export async function resolveApp(nameOrId: string): Promise<App> {
  const apps = await getApps();

  // Try numeric ID first
  const id = parseInt(nameOrId, 10);
  if (!isNaN(id)) {
    const app = apps.find((a) => a.id === id);
    if (app) return app;
  }

  // Try name (case-insensitive)
  const lower = nameOrId.toLowerCase();
  const app = apps.find((a) => a.name.toLowerCase() === lower);
  if (app) return app;

  console.error(`App not found: ${nameOrId}`);
  console.error(`Available apps: ${apps.map((a) => a.name).join(", ") || "(none)"}`);
  process.exit(1);
}
