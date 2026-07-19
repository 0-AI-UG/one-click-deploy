import { requireConfig } from "./config.ts";
import { VERSION } from "./version.ts";
import { DIM, RESET, YELLOW } from "./format.ts";

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

export async function get<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("POST", path, body);
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("PUT", path, body);
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
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Transient gateway / network conditions worth retrying a poll through. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const config = requireConfig();
  const url = `${config.panel_url}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${config.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Transport-level failure (panel unreachable, connection reset, DNS, …).
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, method, path, `${method} ${path} — could not reach panel: ${detail}`);
  }

  checkBackendVersion(res);

  if (res.status === 401) {
    console.error("Session expired. Run `ocd login` again.");
    process.exit(1);
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    const server = err?.error ? `: ${err.error}` : "";
    throw new ApiError(
      res.status,
      method,
      path,
      `${method} ${path} → HTTP ${res.status} ${res.statusText}${server}`,
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
    cachedApps = await get<App[]>("/api/apps");
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
