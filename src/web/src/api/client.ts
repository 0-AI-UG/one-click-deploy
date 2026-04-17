import { getCurrentOrgId } from "../stores/auth.ts";

const API_BASE = window.location.origin;

let getToken: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

export function configureClient(opts: {
  getToken: () => string | null;
  onUnauthorized: () => void;
}) {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

// Default `any` keeps the ergonomic `await get("/x").then(res => res.field)`
// pattern across ~30 call sites. Callers that care pass an explicit `<T>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    onUnauthorized();
    throw new Error("Unauthorized");
  }

  if (res.status === 403) {
    const data = await res.json();
    throw new Error(data.error || "Forbidden");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const get = <T = any>(path: string) => api<T>("GET", path);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const post = <T = any>(path: string, body?: unknown) => api<T>("POST", path, body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const put = <T = any>(path: string, body?: unknown) => api<T>("PUT", path, body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const del = <T = any>(path: string) => api<T>("DELETE", path);
