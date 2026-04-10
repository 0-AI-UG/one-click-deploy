import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, StatusBadge, Spinner, showToast, confirm, Table, Checkbox } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { ArrowLeft, RefreshCw, Play, Pause, RotateCcw, Trash2, GitBranch, HardDrive, ScrollText, Clock, Cpu, Terminal, Gauge, Server as ServerIcon, Zap, History, Info, Plus, Minus, Lock, Settings as SettingsIcon, Pencil } from "lucide-react";

// Small icon-only tooltip — uses native browser title for zero-dependency
// hover help text. Sits inline next to labels so the visible UI stays terse.
function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex items-center text-muted hover:text-fg cursor-help">
      <Info size={11} />
    </span>
  );
}

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
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "webhooks" | "settings">("overview");
  const [nameEdit, setNameEdit] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [portEdit, setPortEdit] = useState<number>(0);
  const [envEdit, setEnvEdit] = useState<{ key: string; value: string }[]>([]);
  const [volumeForm, setVolumeForm] = useState<{ size: number; mount_path: string }>({ size: 10, mount_path: "/data" });
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<any[]>([]);
  const [replicas, setReplicas] = useState<any[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<any[]>([]);
  const [scalingEvents, setScalingEvents] = useState<any[]>([]);
  const [allServers, setAllServers] = useState<any[]>([]);
  const [policy, setPolicy] = useState<{
    autoscale_enabled: boolean;
    min_replicas: number;
    max_replicas: number;
    cpu_threshold: number;
    mem_threshold: number;
    cooldown: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tail, setTail] = useState(100);
  const [webhookForm, setWebhookForm] = useState<{ branch: string; path: string }>({ branch: "main", path: "" });

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
      const [reps, hist, events, servers] = await Promise.all([
        get(`/api/apps/${appId}/replicas`),
        get(`/api/apps/${appId}/metrics/history?since=3600`),
        get(`/api/apps/${appId}/scaling-events`).catch(() => []),
        get(`/api/servers`).catch(() => []),
      ]);
      setReplicas(reps);
      setMetricsHistory(hist.samples || []);
      setScalingEvents(events || []);
      setAllServers(servers || []);
    } catch {}
  };

  // Seed policy form from app when scaling tab opens
  useEffect(() => {
    if (tab === "scaling" && app && !policy) {
      setPolicy({
        autoscale_enabled: !!app.autoscale_enabled,
        min_replicas: app.min_replicas ?? 1,
        max_replicas: app.max_replicas ?? 3,
        cpu_threshold: app.autoscale_cpu_threshold ?? 70,
        mem_threshold: app.autoscale_mem_threshold ?? 80,
        cooldown: app.autoscale_cooldown ?? 300,
      });
    }
  }, [tab, app]);

  useEffect(() => {
    if (tab === "logs") loadLogs();
    if (tab === "deployments") loadDeployments();
    if (tab === "overview" || tab === "scaling") loadReplicas();
    if (tab === "settings" && app) {
      setNameEdit(app.name || "");
      setAuthPassword(app.auth_password || "");
      setPortEdit(app.container_port || 0);
      const ev = app.env_vars ? (typeof app.env_vars === "string" ? JSON.parse(app.env_vars) : app.env_vars) : {};
      setEnvEdit(Object.entries(ev).map(([k, v]) => ({ key: k, value: String(v) })));
      if (app.volume_mount) {
        const parts = String(app.volume_mount).split(":");
        setVolumeForm((f) => ({ ...f, mount_path: parts[1] || "/data" }));
      }
    }
  }, [tab, app]);

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
    { key: "settings", label: "Settings" },
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
      <div className="flex border-b-2 border-fg mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-wider border-b-2 -mb-[2px] transition-all ${
              tab === t.key
                ? "border-fg text-fg bg-accent"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4 space-y-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
            <div className="space-y-2 text-[10px] font-mono">
              <div className="flex justify-between"><span className="text-muted">Git Repo</span><span className="text-fg font-bold">{app.git_repo}</span></div>
              <div className="flex justify-between"><span className="text-muted">Deploy Mode</span><span className="text-fg">{app.deploy_mode}</span></div>
              <div className="flex justify-between"><span className="text-muted">Container Port</span><span className="text-fg">{app.container_port}</span></div>
              {replicas[0]?.host_port != null && (
                <div className="flex justify-between"><span className="text-muted">Host Port</span><span className="text-fg">{replicas[0].host_port}</span></div>
              )}
              {app.volume_id && <div className="flex justify-between"><span className="text-muted">Volume</span><span className="text-fg">{app.volume_mount}</span></div>}
              {app.auth_password && <div className="flex justify-between"><span className="text-muted">Auth</span><span className="text-accent-amber font-bold">Password protected</span></div>}
              {app.deployed_by_username && <div className="flex justify-between"><span className="text-muted">Last deployed by</span><span className="text-fg">{app.deployed_by_username}</span></div>}
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

          {/* Active Replicas */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ServerIcon size={14} className="text-fg" />
                <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Active Replicas</h3>
              </div>
              <Btn size="xs" variant="ghost" onClick={async () => {
                try {
                  setReplicas(await get(`/api/apps/${appId}/metrics`));
                  showToast("Metrics refreshed", "info");
                } catch {}
              }}><RefreshCw size={12} /> Refresh Metrics</Btn>
            </div>
            {replicas.length === 0 ? (
              <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No replicas yet</p>
            ) : (
              <Table headers={["ID", "Container", "Server", "Port", "Status", "CPU", "Memory", "CPU (1h)", ""]}>
                {replicas.map((r: any) => {
                  const series = metricsHistory
                    .filter((s: any) => s.replica_id === r.id)
                    .map((s: any) => s.cpu_percent);
                  const srv = allServers.find((s: any) => s.id === r.server_id);
                  return (
                    <tr key={r.id}>
                      <td className="py-2 px-3 text-fg font-bold">#{r.id}</td>
                      <td className="py-2 px-3 text-fg-dim">{r.container_name}</td>
                      <td className="py-2 px-3 text-fg-dim text-[9px]">{srv?.name || `srv#${r.server_id}`}</td>
                      <td className="py-2 px-3 text-fg-dim">{r.host_port}</td>
                      <td className="py-2 px-3"><StatusBadge status={r.status} /></td>
                      <td className="py-2 px-3 text-fg-dim">{r.cpu_percent?.toFixed(1)}%</td>
                      <td className="py-2 px-3 text-fg-dim">{r.memory_percent?.toFixed(1)}%</td>
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
          </Card>

          {/* Recent scaling events */}
          {scalingEvents.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <History size={14} className="text-fg" />
                <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Recent Scaling Events</h3>
              </div>
              <Table headers={["When", "Event", "From → To", "Reason"]}>
                {scalingEvents.slice(0, 20).map((e: any) => (
                  <tr key={e.id}>
                    <td className="py-2 px-3 text-muted text-[9px]">{new Date(e.created_at).toLocaleString()}</td>
                    <td className="py-2 px-3 text-fg font-bold text-[9px] uppercase tracking-wider">{e.event_type}</td>
                    <td className="py-2 px-3 text-fg-dim">{e.from_count} → {e.to_count}</td>
                    <td className="py-2 px-3 text-fg-dim text-[9px]">{e.reason || "—"}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
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
        <div className="space-y-4">
          {/* Manual scale: WHERE to place the next replica */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Manual Scaling</h3>
              <span className="ml-auto font-mono text-[9px] text-muted uppercase tracking-wider">
                {replicas.length} running · desired {app.desired_replicas ?? replicas.length}
              </span>
            </div>

            {/* Replica count bar — one block per current replica + ghost block for target */}
            <div className="flex gap-1 mb-4">
              {Array.from({ length: Math.max(replicas.length, 1) }).map((_, i) => (
                <div key={i} className="flex-1 h-8 border-2 border-fg bg-accent shadow-neo-sm" />
              ))}
            </div>

            <PermissionGate permission="scaling.manage">
              <div className="flex justify-end gap-2">
                <Btn
                  size="sm"
                  variant="ghost"
                  disabled={replicas.length <= 1}
                  loading={actionLoading === "scale-down"}
                  title="Remove one replica"
                  onClick={() => action("scale-down", async () => {
                    const current = replicas.length || app.desired_replicas || 1;
                    if (current <= 1) return;
                    await post(`/api/apps/${appId}/scale`, { replicas: current - 1 });
                    await loadReplicas();
                  })}
                >–</Btn>
                <Btn
                  size="sm"
                  loading={actionLoading === "scale-up"}
                  title="Add one replica. Placement is automatic: reuse a ready server with no replica of this app, or provision a new one."
                  onClick={() => action("scale-up", async () => {
                    const current = replicas.length || app.desired_replicas || 1;
                    await post(`/api/apps/${appId}/scale`, { replicas: current + 1 });
                    await loadReplicas();
                  })}
                >+</Btn>
              </div>
            </PermissionGate>
          </Card>

          {/* Autoscale policy: WHEN to scale */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Gauge size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Autoscale Policy</h3>
              <span className={`ml-auto font-mono text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 border-2 border-fg ${policy?.autoscale_enabled ? "bg-accent text-fg" : "bg-alt text-muted"}`}>
                {policy?.autoscale_enabled ? "Active" : "Off"}
              </span>
            </div>

            {policy && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={policy.autoscale_enabled}
                    onChange={(v) => setPolicy({ ...policy, autoscale_enabled: v })}
                    label="Enable autoscaling"
                  />
                  <InfoTip text="Reconciler checks CPU/memory every 30s and scales between min and max replicas." />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Min <InfoTip text="Lowest replica count the autoscaler is allowed to scale down to." /></label>
                    <input
                      type="number"
                      min={1}
                      value={policy.min_replicas}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, min_replicas: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Max <InfoTip text="Highest replica count the autoscaler will scale up to." /></label>
                    <input
                      type="number"
                      min={1}
                      value={policy.max_replicas}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, max_replicas: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">CPU % <InfoTip text="Average CPU above this triggers scale-up. Scale-down kicks in below half this value." /></label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={policy.cpu_threshold}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, cpu_threshold: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Mem % <InfoTip text="Average memory above this triggers scale-up. Scale-down kicks in below half this value." /></label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={policy.mem_threshold}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, mem_threshold: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Cooldown s <InfoTip text="Minimum seconds between scaling actions to prevent flapping." /></label>
                    <input
                      type="number"
                      min={30}
                      value={policy.cooldown}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, cooldown: parseInt(e.target.value) || 30 })}
                    />
                  </div>
                </div>

                <PermissionGate permission="scaling.manage">
                  <div className="flex justify-end">
                    <Btn
                      size="sm"
                      variant="primary"
                      loading={actionLoading === "policy"}
                      onClick={() => action("policy", async () => {
                        await put(`/api/apps/${appId}/scaling-policy`, policy);
                        await load();
                      })}
                    >Save Policy</Btn>
                  </div>
                </PermissionGate>
              </div>
            )}
          </Card>
        </div>
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
              <>
                <div className="flex justify-between"><span className="text-muted">Branch</span><span>{app.webhook_branch}</span></div>
                <div className="flex justify-between"><span className="text-muted">Path filter</span><span>{app.webhook_path || "—"}</span></div>
              </>
            )}
          </div>
          <PermissionGate permission="webhooks.manage">
            {app.webhook_enabled ? (
              <Btn size="xs" variant="danger" loading={actionLoading === "disable-webhook"} onClick={() => action("disable-webhook", () => post(`/api/apps/${appId}/webhook/disable`))}>
                Disable Webhook
              </Btn>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Branch</label>
                  <input
                    type="text"
                    value={webhookForm.branch}
                    onChange={(e) => setWebhookForm((f) => ({ ...f, branch: e.target.value }))}
                    placeholder="main"
                  />
                </div>
                <div>
                  <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Path filter (optional)</label>
                  <input
                    type="text"
                    value={webhookForm.path}
                    onChange={(e) => setWebhookForm((f) => ({ ...f, path: e.target.value }))}
                    placeholder="e.g. services/api"
                  />
                </div>
                <Btn size="xs" variant="primary" loading={actionLoading === "enable-webhook"} onClick={() => action("enable-webhook", () => post(`/api/apps/${appId}/webhook/enable`, { branch: webhookForm.branch || "main", path: webhookForm.path || undefined }))}>
                  Enable Webhook
                </Btn>
              </div>
            )}
          </PermissionGate>
        </Card>
      )}

      {tab === "settings" && (
        <div className="space-y-4">
          {/* Rename */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Pencil size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">App Name</h3>
            </div>
            <p className="text-[10px] text-muted font-mono mb-3">
              Rename this app. This changes the container name and app directory on the server.
            </p>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={nameEdit}
                onChange={(e) => setNameEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder={app.name}
              />
              <PermissionGate permission="apps.deploy">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "rename"}
                  disabled={!nameEdit || nameEdit === app.name}
                  onClick={() => action("rename", async () => {
                    await put(`/api/apps/${appId}/rename`, { name: nameEdit });
                  })}
                >Rename</Btn>
              </PermissionGate>
            </div>
          </Card>

          {/* Auth password */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Lock size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Password Protection</h3>
            </div>
            <p className="text-[10px] text-muted font-mono mb-3">
              Set a password to gate access to this app. Leave blank to remove. Saving triggers a redeploy.
            </p>
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="(none)"
            />
          </Card>

          {/* Container port */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <SettingsIcon size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container Port</h3>
            </div>
            <p className="text-[10px] text-muted font-mono mb-3">
              The port your app listens on inside the container. Saving triggers a rebuild and redeploy.
            </p>
            <input
              type="number"
              min={1}
              max={65535}
              value={portEdit || ""}
              onChange={(e) => setPortEdit(parseInt(e.target.value) || 0)}
              placeholder="3000"
            />
          </Card>

          {/* Env vars */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <SettingsIcon size={14} className="text-fg" />
                <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Environment Variables</h3>
              </div>
              <Btn size="xs" variant="ghost" onClick={() => setEnvEdit([...envEdit, { key: "", value: "" }])}>
                <Plus size={12} /> Add
              </Btn>
            </div>
            {envEdit.length === 0 ? (
              <p className="text-[10px] text-muted font-mono mb-2">No environment variables.</p>
            ) : (
              envEdit.map((v, i) => (
                <div key={i} className="flex gap-2 items-center mt-2">
                  <input
                    type="text"
                    value={v.key}
                    placeholder="KEY"
                    onChange={(e) => {
                      const next = [...envEdit];
                      next[i].key = e.target.value;
                      setEnvEdit(next);
                    }}
                    className="!w-1/3"
                  />
                  <input
                    type="text"
                    value={v.value}
                    placeholder="value"
                    onChange={(e) => {
                      const next = [...envEdit];
                      next[i].value = e.target.value;
                      setEnvEdit(next);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setEnvEdit(envEdit.filter((_, j) => j !== i))}
                    className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
                  >
                    <Minus size={14} />
                  </button>
                </div>
              ))
            )}
          </Card>

          {/* Combined save */}
          <PermissionGate permission="apps.redeploy">
            <div className="flex justify-end">
              <Btn
                size="sm"
                variant="primary"
                loading={actionLoading === "save-settings"}
                disabled={!portEdit}
                onClick={() => action("save-settings", async () => {
                  const env_vars: Record<string, string> = {};
                  for (const { key, value } of envEdit) {
                    if (key.trim()) env_vars[key.trim()] = value;
                  }
                  await post(`/api/apps/${appId}/redeploy`, {
                    env_vars,
                    auth_password: authPassword || null,
                    container_port: portEdit,
                  });
                })}
              >Save & Redeploy</Btn>
            </div>
          </PermissionGate>

          {/* Volume */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <HardDrive size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Persistent Volume</h3>
            </div>
            {app.volume_id ? (
              <>
                <div className="space-y-1 text-[10px] font-mono mb-3">
                  <div className="flex justify-between"><span className="text-muted">Volume ID</span><span className="text-fg">{app.volume_id}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Mount</span><span className="text-fg">{app.volume_mount}</span></div>
                </div>
                <p className="text-[10px] text-muted font-mono mb-3">
                  Detaching keeps the volume in Hetzner but unmounts it from this app. The container will be recreated.
                </p>
                <PermissionGate permission="volumes.manage">
                  <div className="flex justify-end">
                    <Btn
                      size="sm"
                      variant="danger"
                      loading={actionLoading === "detach-vol"}
                      onClick={async () => {
                        if (await confirm("Detach Volume", "Detach this volume? Data is preserved on the volume itself.", true)) {
                          await action("detach-vol", () => post(`/api/volumes/detach`, { app_id: appId }));
                        }
                      }}
                    >Detach Volume</Btn>
                  </div>
                </PermissionGate>
              </>
            ) : (
              <>
                <p className="text-[10px] text-muted font-mono mb-3">
                  Attach a new persistent volume. The container will be recreated with the volume mounted.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Size (GB)</label>
                    <input
                      type="number"
                      min={10}
                      value={volumeForm.size}
                      onChange={(e) => setVolumeForm({ ...volumeForm, size: parseInt(e.target.value) || 10 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Mount Path</label>
                    <input
                      type="text"
                      value={volumeForm.mount_path}
                      onChange={(e) => setVolumeForm({ ...volumeForm, mount_path: e.target.value })}
                      placeholder="/data"
                    />
                  </div>
                </div>
                <PermissionGate permission="volumes.create">
                  <div className="flex justify-end mt-3">
                    <Btn
                      size="sm"
                      variant="primary"
                      loading={actionLoading === "attach-vol"}
                      onClick={() => action("attach-vol", () => post(`/api/volumes/attach`, {
                        app_id: appId,
                        size: volumeForm.size,
                        mount_path: volumeForm.mount_path || "/data",
                      }))}
                    >Attach Volume</Btn>
                  </div>
                </PermissionGate>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
