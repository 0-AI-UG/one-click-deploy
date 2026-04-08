import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, StatusBadge, Spinner, showToast, confirm, Table, Checkbox } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { ArrowLeft, RefreshCw, Play, Pause, RotateCcw, Trash2, GitBranch, HardDrive, ScrollText, Clock, Cpu, Terminal, Gauge, Server as ServerIcon, Zap, History } from "lucide-react";

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
  const [scalingEvents, setScalingEvents] = useState<any[]>([]);
  const [allServers, setAllServers] = useState<any[]>([]);
  const [targetServerId, setTargetServerId] = useState<string>("auto");
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
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">
                    Place Next Replica On
                  </label>
                  <NeoSelect
                    value={targetServerId}
                    onChange={setTargetServerId}
                    options={[
                      { value: "auto", label: "Auto — least loaded / new server" },
                      ...allServers
                        .filter((s: any) => s.status === "ready")
                        .map((s: any) => {
                          const count = replicas.filter((r: any) => r.server_id === s.id).length;
                          const isPrimary = s.id === app.server_id;
                          return {
                            value: String(s.id),
                            label: `${s.name} · ${s.location} · ${s.type} · ${count} replica${count === 1 ? "" : "s"}${isPrimary ? " · primary" : ""}`,
                          };
                        }),
                    ]}
                  />
                  <p className="font-mono text-[9px] text-muted mt-1">
                    Where to scale. "Auto" provisions a new server if every ready server already hosts a replica.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Btn
                    size="sm"
                    loading={actionLoading === "scale-up"}
                    onClick={() => action("scale-up", async () => {
                      const current = replicas.length || app.desired_replicas || 1;
                      await post(`/api/apps/${appId}/scale`, {
                        replicas: current + 1,
                        target_server_id: targetServerId === "auto" ? undefined : Number(targetServerId),
                      });
                      await loadReplicas();
                    })}
                  >+ Scale Up</Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={replicas.length <= 1}
                    loading={actionLoading === "scale-down"}
                    onClick={() => action("scale-down", async () => {
                      const current = replicas.length || app.desired_replicas || 1;
                      if (current <= 1) return;
                      await post(`/api/apps/${appId}/scale`, { replicas: current - 1 });
                      await loadReplicas();
                    })}
                  >– Scale Down</Btn>
                </div>
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
                <Checkbox
                  checked={policy.autoscale_enabled}
                  onChange={(v) => setPolicy({ ...policy, autoscale_enabled: v })}
                  label="Enable autoscaling — the reconciler checks metrics every 30s and scales automatically"
                />

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Min Replicas</label>
                    <input
                      type="number"
                      min={1}
                      value={policy.min_replicas}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, min_replicas: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Max Replicas</label>
                    <input
                      type="number"
                      min={1}
                      value={policy.max_replicas}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, max_replicas: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">CPU Threshold %</label>
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
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Memory Threshold %</label>
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
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Cooldown (sec)</label>
                    <input
                      type="number"
                      min={30}
                      value={policy.cooldown}
                      disabled={!policy.autoscale_enabled}
                      onChange={(e) => setPolicy({ ...policy, cooldown: parseInt(e.target.value) || 30 })}
                    />
                  </div>
                </div>

                <div className="text-[10px] font-mono text-muted bg-alt border-2 border-fg px-3 py-2">
                  <span className="text-fg font-bold">RULE →</span>{" "}
                  scale up when avg CPU &gt; <span className="text-fg">{policy.cpu_threshold}%</span> or mem &gt; <span className="text-fg">{policy.mem_threshold}%</span>,
                  scale down when both are below half-threshold,
                  bounded by <span className="text-fg">{policy.min_replicas}–{policy.max_replicas}</span>,
                  waiting <span className="text-fg">{policy.cooldown}s</span> between changes.
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

          {/* Replicas table */}
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
