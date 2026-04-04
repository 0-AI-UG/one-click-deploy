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

export function api(method: string, path: string, body?: any): Promise<any> {
  return apiFetch(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export const get = (path: string) => api("GET", path);
export const post = (path: string, body?: any) => api("POST", path, body);
export const put = (path: string, body?: any) => api("PUT", path, body);
export const del = (path: string) => api("DELETE", path);
