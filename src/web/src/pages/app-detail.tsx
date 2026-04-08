import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, StatusBadge, Spinner, showToast, confirm, Table } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { ArrowLeft, RefreshCw, Play, Pause, RotateCcw, Trash2, GitBranch, HardDrive, ScrollText, Clock, Cpu, Terminal } from "lucide-react";

function Sparkline({ values, color = "#3b82f6" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <span className="text-[9px] text-muted font-mono">no data</span>;
  const w = 120, h = 24;
  const max = Math.max(100, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function AppDetailPage({ appId }: { appId: number }) {
  const [app, setApp] = useState<any>(null);
  const [server, setServer] = useState<any>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "webhooks">("overview");
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<any[]>([]);
  const [replicas, setReplicas] = useState<any[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tail, setTail] = useState(100);

  const load = async () => {
    try {
      const servers = await get("/api/servers");
      for (const s of servers) {
        const found = s.apps.find((a: any) => a.id === appId);
        if (found) { setApp(found); setServer(s); break; }
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [appId]);

  const loadLogs = async () => {
    try {
      const res = await get(`/api/apps/${appId}/logs?tail=${tail}`);
      setLogs(res.logs || res.error || "No logs available");
    } catch (err: any) {
      setLogs(err.message);
    }
  };

  const loadDeployments = async () => {
    try {
      setDeployments(await get(`/api/apps/${appId}/deployments`));
    } catch {}
  };

  const loadReplicas = async () => {
    try {
      setReplicas(await get(`/api/apps/${appId}/replicas`));
      const hist = await get(`/api/apps/${appId}/metrics/history?since=3600`);
      setMetricsHistory(hist.samples || []);
    } catch {}
  };

  useEffect(() => {
    if (tab === "logs") loadLogs();
    if (tab === "deployments") loadDeployments();
    if (tab === "scaling") loadReplicas();
  }, [tab]);

  const action = async (name: string, fn: () => Promise<any>) => {
    setActionLoading(name);
    try {
      await fn();
      showToast(`${name} successful`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (!app) return <div className="text-center py-20 text-muted font-mono text-[10px] uppercase tracking-wider">App not found</div>;

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
    { key: "deployments", label: "Deployments" },
    { key: "scaling", label: "Scaling" },
    { key: "webhooks", label: "Webhooks" },
  ];

  const envVars = app.env_vars ? (typeof app.env_vars === "string" ? JSON.parse(app.env_vars) : app.env_vars) : {};

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{app.name}</h1>
            <StatusBadge status={app.status} />
          </div>
          {app.domain && <p className="font-mono text-[9px] text-muted mt-0.5">{app.domain} — {server?.name} ({server?.ipv4})</p>}
        </div>
        <div className="flex gap-1">
          <PermissionGate permission="apps.restart">
            <Btn size="xs" loading={actionLoading === "restart"} onClick={() => action("restart", () => post(`/api/apps/${appId}/restart`))}>
              <RotateCcw size={12} /> Restart
            </Btn>
          </PermissionGate>
          <PermissionGate permission="apps.pause">
            {app.status === "paused" ? (
              <Btn size="xs" loading={actionLoading === "unpause"} onClick={() => action("unpause", () => post(`/api/apps/${appId}/unpause`))}>
                <Play size={12} /> Unpause
              </Btn>
            ) : (
              <Btn size="xs" loading={actionLoading === "pause"} onClick={() => action("pause", () => post(`/api/apps/${appId}/pause`))}>
                <Pause size={12} /> Pause
              </Btn>
            )}
          </PermissionGate>
          <PermissionGate permission="apps.redeploy">
            <Btn size="xs" variant="primary" loading={actionLoading === "redeploy"} onClick={() => action("redeploy", () => post(`/api/apps/${appId}/redeploy`))}>
              <RefreshCw size={12} /> Redeploy
            </Btn>
          </PermissionGate>
          <PermissionGate permission="apps.destroy">
            <Btn
              size="xs" variant="danger"
              loading={actionLoading === "destroy"}
              onClick={async () => {
                if (await confirm("Destroy App", `Permanently destroy "${app.name}"?`, true)) {
                  await action("destroy", () => del(`/api/apps/${appId}`));
                  window.location.hash = "#/";
                }
              }}
            ><Trash2 size={12} /> Destroy</Btn>
          </PermissionGate>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-4 border-b-2 border-fg">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-wider transition-all border-2 border-fg -mb-0.5 ${
              tab === t.key
                ? "bg-accent text-fg border-b-accent"
                : "text-muted hover:text-fg bg-alt border-b-fg"
            }`}
          >{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4 space-y-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
            <div className="space-y-2 text-[10px] font-mono">
              <div className="flex justify-between"><span className="text-muted">Git Repo</span><span className="text-fg font-bold">{app.git_repo}</span></div>
              <div className="flex justify-between"><span className="text-muted">Deploy Mode</span><span className="text-fg">{app.deploy_mode}</span></div>
              <div className="flex justify-between"><span className="text-muted">Container Port</span><span className="text-fg">{app.container_port}</span></div>
              <div className="flex justify-between"><span className="text-muted">Host Port</span><span className="text-fg">{app.host_port}</span></div>
              {app.volume_id && <div className="flex justify-between"><span className="text-muted">Volume</span><span className="text-fg">{app.volume_mount}</span></div>}
              {app.auth_password && <div className="flex justify-between"><span className="text-muted">Auth</span><span className="text-accent-amber font-bold">Password protected</span></div>}
            </div>
          </Card>
          <Card className="p-4 space-y-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Environment Variables</h3>
            {Object.keys(envVars).length === 0 ? (
              <p className="text-[10px] text-muted font-mono">No environment variables set</p>
            ) : (
              <div className="space-y-1 text-[10px] font-mono">
                {Object.entries(envVars).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4">
                    <span className="text-accent-blue font-bold">{k}</span>
                    <span className="text-fg-dim truncate">{String(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "logs" && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ScrollText size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container Logs</h3>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-24">
                <NeoSelect
                  value={String(tail)}
                  onChange={(v) => setTail(parseInt(v))}
                  options={[50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} lines` }))}
                  compact
                />
              </div>
              <Btn size="xs" onClick={loadLogs}><RefreshCw size={12} /> Refresh</Btn>
            </div>
          </div>
          <pre className="bg-fg border-2 border-fg p-3 max-h-96 overflow-auto text-[10px] font-mono text-accent/80 whitespace-pre-wrap">{logs || "Loading..."}</pre>
        </Card>
      )}

      {tab === "deployments" && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deployment History</h3>
          </div>
          {deployments.length === 0 ? (
            <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No deployments yet</p>
          ) : (
            <Table headers={["ID", "Image", "Commit", "Source", "Status", "Date", ""]}>
              {deployments.map((d: any) => (
                <tr key={d.id} className="hover:bg-alt/50">
                  <td className="py-2 px-3 text-fg font-bold">#{d.id}</td>
                  <td className="py-2 px-3 text-fg-dim">{d.image_tag}</td>
                  <td className="py-2 px-3 text-fg-dim">{d.git_commit?.slice(0, 7) || "—"}</td>
                  <td className="py-2 px-3 text-fg-dim uppercase tracking-wider text-[9px]">{d.source || "manual"}</td>
                  <td className="py-2 px-3"><StatusBadge status={d.status} /></td>
                  <td className="py-2 px-3 text-muted">{new Date(d.created_at).toLocaleString()}</td>
                  <td className="py-2 px-3">
                    {d.status !== "failed" && (
                      <PermissionGate permission="apps.rollback">
                        <Btn
                          size="xs" variant="ghost"
                          onClick={async () => {
                            if (await confirm("Rollback", `Rollback to deployment #${d.id}?`)) {
                              action("rollback", () => post(`/api/apps/${appId}/rollback`, { deployment_id: d.id }));
                            }
                          }}
                        >Rollback</Btn>
                      </PermissionGate>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === "scaling" && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Scaling & Replicas</h3>
          </div>
          <div className="space-y-3 text-[10px] font-mono mb-4">
            <div className="flex justify-between"><span className="text-muted">Desired Replicas</span><span className="font-bold">{app.desired_replicas}</span></div>
            <div className="flex justify-between"><span className="text-muted">Autoscale</span><span className="font-bold">{app.autoscale_enabled ? "Enabled" : "Disabled"}</span></div>
            {app.autoscale_enabled && (
              <>
                <div className="flex justify-between"><span className="text-muted">Min/Max</span><span>{app.min_replicas}–{app.max_replicas}</span></div>
                <div className="flex justify-between"><span className="text-muted">CPU Threshold</span><span>{app.autoscale_cpu_threshold}%</span></div>
                <div className="flex justify-between"><span className="text-muted">Memory Threshold</span><span>{app.autoscale_mem_threshold}%</span></div>
              </>
            )}
          </div>
          {replicas.length > 0 && (
            <Table headers={["ID", "Container", "Port", "Status", "CPU", "Memory", "Last Health", "CPU (1h)", ""]}>
              {replicas.map((r: any) => {
                const series = metricsHistory
                  .filter((s: any) => s.replica_id === r.id)
                  .map((s: any) => s.cpu_percent);
                return (
                  <tr key={r.id}>
                    <td className="py-2 px-3 text-fg font-bold">#{r.id}</td>
                    <td className="py-2 px-3 text-fg-dim">{r.container_name}</td>
                    <td className="py-2 px-3 text-fg-dim">{r.host_port}</td>
                    <td className="py-2 px-3"><StatusBadge status={r.status} /></td>
                    <td className="py-2 px-3 text-fg-dim">{r.cpu_percent?.toFixed(1)}%</td>
                    <td className="py-2 px-3 text-fg-dim">{r.memory_percent?.toFixed(1)}%</td>
                    <td className="py-2 px-3 text-muted text-[9px]">{r.last_health_at ? new Date(r.last_health_at + "Z").toLocaleTimeString() : "—"}</td>
                    <td className="py-2 px-3"><Sparkline values={series} /></td>
                    <td className="py-2 px-3">
                      <PermissionGate permission="terminal.access">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
                          <Terminal size={12} /> Shell
                        </Btn>
                      </PermissionGate>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <div className="flex gap-2 mt-3">
            <PermissionGate permission="scaling.manage">
              <Btn size="xs" onClick={() => action("scale", () => post(`/api/apps/${appId}/scale`, { replicas: app.desired_replicas + 1 }))}>Scale Up</Btn>
              {app.desired_replicas > 1 && (
                <Btn size="xs" onClick={() => action("scale", () => post(`/api/apps/${appId}/scale`, { replicas: app.desired_replicas - 1 }))}>Scale Down</Btn>
              )}
              <Btn size="xs" variant="ghost" onClick={async () => {
                try {
                  setReplicas(await get(`/api/apps/${appId}/metrics`));
                  showToast("Metrics refreshed", "info");
                } catch {}
              }}><RefreshCw size={12} /> Refresh Metrics</Btn>
            </PermissionGate>
          </div>
        </Card>
      )}

      {tab === "webhooks" && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Webhook</h3>
          </div>
          <div className="space-y-2 text-[10px] font-mono mb-4">
            <div className="flex justify-between"><span className="text-muted">Status</span><span className={`font-bold ${app.webhook_enabled ? "text-fg" : "text-muted"}`}>{app.webhook_enabled ? "Enabled" : "Disabled"}</span></div>
            {app.webhook_enabled && (
              <div className="flex justify-between"><span className="text-muted">Branch</span><span>{app.webhook_branch}</span></div>
            )}
          </div>
          <PermissionGate permission="webhooks.manage">
            {app.webhook_enabled ? (
              <Btn size="xs" variant="danger" loading={actionLoading === "disable-webhook"} onClick={() => action("disable-webhook", () => post(`/api/apps/${appId}/webhook/disable`))}>
                Disable Webhook
              </Btn>
            ) : (
              <Btn size="xs" variant="primary" loading={actionLoading === "enable-webhook"} onClick={() => action("enable-webhook", () => post(`/api/apps/${appId}/webhook/enable`, { branch: "main" }))}>
                Enable Webhook
              </Btn>
            )}
          </PermissionGate>
        </Card>
      )}
    </div>
  );
}
