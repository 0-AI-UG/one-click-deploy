const API_BASE = "http://localhost:3001";

type ProgressData = { app_name: string; step: string; detail: string };
type ProgressListener = (data: ProgressData) => void;

const progressListeners = new Set<ProgressListener>();

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

const get = (path: string) => apiFetch(path);
const post = (path: string, body?: any) =>
  apiFetch(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const put = (path: string, body?: any) =>
  apiFetch(path, { method: "PUT", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const del = (path: string) => apiFetch(path, { method: "DELETE" });

// Maps RPC method names to HTTP calls, preserving the same interface
// that all mainview components expect: request.methodName(params)
const methods: Record<string, (params: any) => Promise<any>> = {
  getServers: () => get("/api/servers"),
  getApps: () => get("/api/apps"),
  getSettings: () => get("/api/settings"),
  saveSettings: (settings) => put("/api/settings", settings),
  deploy: (req) => post("/api/apps/deploy", req),
  destroyApp: ({ app_id }) => del(`/api/apps/${app_id}`),
  deleteServer: ({ server_id }) => del(`/api/servers/${server_id}`),
  refreshServers: () => post("/api/servers/refresh"),
  getDeployLog: async ({ app_id }) => {
    const data = await get(`/api/apps/${app_id}/deploy-log`);
    return data.log; // server wraps in { log }, RPC returned raw string
  },
  openExternal: ({ url }) => {
    window.open(url, "_blank");
    return Promise.resolve({ ok: true });
  },
  restartApp: ({ app_id }) => post(`/api/apps/${app_id}/restart`),
  pauseApp: ({ app_id }) => post(`/api/apps/${app_id}/pause`),
  unpauseApp: ({ app_id }) => post(`/api/apps/${app_id}/unpause`),
  redeployApp: ({ app_id, env_vars, auth_password }) =>
    post(`/api/apps/${app_id}/redeploy`, { env_vars, auth_password }),
  updateAppEnv: ({ app_id, env_vars }) => put(`/api/apps/${app_id}/env`, { env_vars }),
  getContainerLogs: ({ app_id, tail }) => get(`/api/apps/${app_id}/logs?tail=${tail ?? 100}`),
  getDeployments: ({ app_id }) => get(`/api/apps/${app_id}/deployments`),
  rollbackApp: ({ app_id, deployment_id }) =>
    post(`/api/apps/${app_id}/rollback`, { deployment_id }),
  enableWebhook: ({ app_id, branch }) =>
    post(`/api/apps/${app_id}/webhook/enable`, { branch }),
  disableWebhook: ({ app_id }) => post(`/api/apps/${app_id}/webhook/disable`),
  scaleApp: ({ app_id, replicas }) => post(`/api/apps/${app_id}/scale`, { replicas }),
  getReplicas: ({ app_id }) => get(`/api/apps/${app_id}/replicas`),
  getScalingEvents: ({ app_id }) => get(`/api/apps/${app_id}/scaling-events`),
  updateScalingPolicy: ({ app_id, min_replicas, max_replicas, autoscale_enabled, cpu_threshold, mem_threshold }) =>
    put(`/api/apps/${app_id}/scaling-policy`, { min_replicas, max_replicas, autoscale_enabled, cpu_threshold, mem_threshold }),
  getAppMetrics: ({ app_id }) => get(`/api/apps/${app_id}/metrics`),
  getResources: () => get("/api/resources"),
  deleteResource: ({ type, id }) => del(`/api/resources/${type}/${id}`),
  resizeVolume: ({ volume_id, size }) => post("/api/volumes/resize", { volume_id, size }),
  attachVolume: ({ app_id, size, mount_path }) =>
    post("/api/volumes/attach", { app_id, size, mount_path }),
  attachExistingVolume: ({ app_id, volume_id, mount_path }) =>
    post("/api/volumes/attach-existing", { app_id, volume_id, mount_path }),
  detachVolume: ({ app_id }) => post("/api/volumes/detach", { app_id }),
  reattachVolume: ({ volume_id, from_app_id, to_app_id, mount_path }) =>
    post("/api/volumes/reattach", { volume_id, from_app_id, to_app_id, mount_path }),
  getServerTypes: () => get("/api/settings/server-types"),
};

export const request = new Proxy({} as any, {
  get(_target, prop: string) {
    const fn = methods[prop];
    if (!fn) throw new Error(`Unknown API method: ${prop}`);
    return fn;
  },
});

export function onDeployProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn);
  return () => {
    progressListeners.delete(fn);
  };
}

// Connect SSE for deploy progress. Call this when a deploy starts.
export function connectDeployStream(appName: string): () => void {
  const es = new EventSource(`${API_BASE}/api/apps/${appName}/deploy/stream`);
  es.onmessage = (event) => {
    try {
      const { step, detail } = JSON.parse(event.data);
      for (const fn of progressListeners) {
        fn({ app_name: appName, step, detail });
      }
    } catch {}
  };
  return () => es.close();
}
