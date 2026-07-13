import { requireConfig } from "./config.ts";

export async function get<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("POST", path, body);
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("PUT", path, body);
}

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = requireConfig();
  const url = `${config.panel_url}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${config.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    console.error("Session expired. Run `ocd login` again.");
    process.exit(1);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
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
  internal_port?: number;
  internal_protocol?: string;
}

/** Where the app answers: its public domain, or the internal address for
 *  private apps (which have no public ingress at all). The scheme follows the
 *  internal routing protocol (http L7 vs raw tcp). */
export function appAddress(app: {
  name: string;
  domain: string;
  public?: boolean | number;
  internal_port?: number;
  internal_protocol?: string;
}): string {
  if (app.public === false || app.public === 0) {
    const scheme = app.internal_protocol === "tcp" ? "tcp" : "http";
    return `${scheme}://${app.name}.ocd.internal:${app.internal_port} (private)`;
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
