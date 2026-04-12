import { useState, useEffect } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, Spinner, showToast, confirm, CopyButton, Table } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import {
  RotateCcw, Pause, Play, Trash2, Server as ServerIcon,
  Link2, Unlink, ScrollText, ArrowLeft, RefreshCw, Terminal,
} from "lucide-react";
import type { ServiceData, AppData, ServiceInstance, LinkedApp } from "../types.ts";

export function ServiceDetailPage({ serviceId }: { serviceId: number }) {
  const [service, setService] = useState<ServiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [apps, setApps] = useState<AppData[]>([]);
  const [linkAppId, setLinkAppId] = useState("");
  const [linkPrefix, setLinkPrefix] = useState("DATABASE");
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [logs, setLogs] = useState("");
  const [tail, setTail] = useState(100);

  const load = async () => {
    try {
      const [svc, appList] = await Promise.all([
        get(`/api/services/${serviceId}`),
        get("/api/apps"),
      ]);
      setService(svc);
      setApps(appList);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const loadLogs = async () => {
    try {
      const data = await get(`/api/services/${serviceId}/logs?tail=${tail}`);
      setLogs(data.logs || "No logs available");
    } catch (err: any) {
      setLogs(err.message);
    }
  };

  useEffect(() => { load(); }, [serviceId]);
  useEffect(() => { if (tab === "logs") loadLogs(); }, [tab, tail]);

  const action = async (act: string, label: string) => {
    setActionLoading(act);
    try {
      if (act === "delete") {
        await del(`/api/services/${serviceId}`);
        showToast("Service destroyed", "success");
        window.location.hash = "#/";
        return;
      }
      await post(`/api/services/${serviceId}/${act}`);
      showToast(`${label} successful`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const linkApp = async () => {
    if (!linkAppId) return;
    setActionLoading("link");
    try {
      await post(`/api/services/${serviceId}/link/${linkAppId}`, { env_prefix: linkPrefix });
      showToast("Service linked to app", "success");
      setLinkAppId("");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const unlinkApp = async (appId: number) => {
    setActionLoading(`unlink-${appId}`);
    try {
      await del(`/api/services/${serviceId}/link/${appId}`);
      showToast("Service unlinked", "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (!service) return <div className="text-center py-20 font-mono text-muted">Service not found</div>;

  const credentials = service.credentials || {};
  const instances = service.instances || [];
  const linkedApps = service.linked_apps || [];
  const unlinkedApps = apps.filter((a: AppData) => !linkedApps.some((l: LinkedApp) => l.id === a.id));

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{service.name}</h1>
            <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{service.service_type}</span>
            <span className="font-mono text-[9px] text-muted">{service.version}</span>
            <StatusBadge status={service.status} />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <PermissionGate permission="services.manage">
            <Btn size="xs" variant="ghost" loading={actionLoading === "restart"} onClick={() => action("restart", "Restart")}>
              <RotateCcw size={12} /> Restart
            </Btn>
          </PermissionGate>
          <PermissionGate permission="services.manage">
            {service.status === "paused" ? (
              <Btn size="xs" variant="ghost" loading={actionLoading === "unpause"} onClick={() => action("unpause", "Unpause")}>
                <Play size={12} /> Unpause
              </Btn>
            ) : (
              <Btn size="xs" variant="ghost" loading={actionLoading === "pause"} onClick={() => action("pause", "Pause")}>
                <Pause size={12} /> Pause
              </Btn>
            )}
          </PermissionGate>
          <PermissionGate permission="services.destroy">
            <Btn
              size="xs"
              variant="ghost"
              loading={actionLoading === "delete"}
              onClick={async () => {
                if (await confirm("Destroy Service", `Permanently destroy "${service.name}"? This removes all containers, volumes, and data.`, true)) {
                  action("delete", "Destroy");
                }
              }}
            >
              <Trash2 size={12} className="text-accent-red" />
            </Btn>
          </PermissionGate>
        </div>
      </div>

      {service.status === "paused" && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-4 border-2 border-fg bg-alt">
          <Pause size={12} className="text-muted" />
          <span className="font-mono text-[10px] text-muted font-bold uppercase tracking-wider">
            Service is paused — container is frozen
          </span>
          <div className="ml-auto">
            <PermissionGate permission="services.manage">
              <Btn size="xs" loading={actionLoading === "unpause"} onClick={() => action("unpause", "Unpause")}>
                <Play size={12} /> Unpause
              </Btn>
            </PermissionGate>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b-2 border-fg mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as typeof tab)}
            className={`px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-wider border-b-2 -mb-[2px] transition-all ${
              tab === t.key
                ? "border-fg text-fg bg-accent"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          {/* Connection Info */}
          <Card>
            <div className="px-4 py-2 border-b-2 border-fg bg-alt">
              <span className="font-mono text-[10px] font-bold text-fg uppercase">Connection Info</span>
            </div>
            <div className="divide-y divide-fg/10">
              {credentials.connection_url && (
                <div className="px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-muted uppercase shrink-0">URL</span>
                  <div className="flex items-center gap-1 min-w-0">
                    <code className="font-mono text-[10px] text-fg truncate">{credentials.connection_url}</code>
                    <CopyButton text={credentials.connection_url} />
                  </div>
                </div>
              )}
              <div className="px-4 py-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] text-muted uppercase shrink-0">Host</span>
                <div className="flex items-center gap-1">
                  <code className="font-mono text-[10px] text-fg">{credentials.host}:{credentials.port}</code>
                  <CopyButton text={`${credentials.host}:${credentials.port}`} />
                </div>
              </div>
              {credentials.internal_host && (
                <div className="px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-muted uppercase shrink-0">Internal</span>
                  <div className="flex items-center gap-1">
                    <code className="font-mono text-[10px] text-fg">{credentials.internal_host}:{credentials.internal_port}</code>
                    <CopyButton text={`${credentials.internal_host}:${credentials.internal_port}`} />
                  </div>
                </div>
              )}
              {credentials.username && (
                <div className="px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-muted uppercase shrink-0">User</span>
                  <div className="flex items-center gap-1">
                    <code className="font-mono text-[10px] text-fg">{credentials.username}</code>
                    <CopyButton text={credentials.username} />
                  </div>
                </div>
              )}
              {credentials.password && (
                <div className="px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-muted uppercase shrink-0">Password</span>
                  <div className="flex items-center gap-1">
                    <code className="font-mono text-[10px] text-fg">{"*".repeat(12)}</code>
                    <CopyButton text={credentials.password} />
                  </div>
                </div>
              )}
              {credentials.database && (
                <div className="px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-muted uppercase shrink-0">Database</span>
                  <div className="flex items-center gap-1">
                    <code className="font-mono text-[10px] text-fg">{credentials.database}</code>
                    <CopyButton text={credentials.database} />
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Container */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ServerIcon size={14} className="text-fg" />
                <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container</h3>
              </div>
              <Btn size="xs" variant="ghost" onClick={load}>
                <RefreshCw size={12} /> Refresh
              </Btn>
            </div>
            {instances.length === 0 ? (
              <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No container running</p>
            ) : (
              <Table headers={["ID", "Container", "Server", "Port", "Status", "CPU", "Memory", ""]}>
                {instances.map((inst: ServiceInstance) => (
                  <tr key={inst.id}>
                    <td className="py-2 px-3 text-fg font-bold">#{inst.id}</td>
                    <td className="py-2 px-3 text-fg-dim">{inst.container_name}</td>
                    <td className="py-2 px-3 text-[9px] text-fg-dim">
                      {inst.server_name || `srv#${inst.server_id}`}
                    </td>
                    <td className="py-2 px-3 text-fg-dim">{inst.host_port}</td>
                    <td className="py-2 px-3"><StatusBadge status={inst.status} /></td>
                    <td className="py-2 px-3 text-fg-dim">{inst.cpu_percent?.toFixed(1)}%</td>
                    <td className="py-2 px-3 text-fg-dim">{inst.memory_percent?.toFixed(1)}%</td>
                    <td className="py-2 px-3">
                      <PermissionGate permission="terminal.access">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/service-instance/${inst.id}`; }}>
                          <Terminal size={12} /> Shell
                        </Btn>
                      </PermissionGate>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {/* Linked Apps */}
          <Card>
            <div className="px-4 py-2 border-b-2 border-fg bg-alt">
              <span className="font-mono text-[10px] font-bold text-fg uppercase">Linked Apps</span>
            </div>
            <div className="p-4 space-y-3">
              {linkedApps.length > 0 ? (
                <div className="divide-y divide-fg/10 border-2 border-fg/20">
                  {linkedApps.map((link: LinkedApp) => (
                    <div key={link.id} className="px-3 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Link2 size={12} className="text-accent-blue" />
                        <a href={`#/apps/${link.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">
                          {link.name}
                        </a>
                        <span className="font-mono text-[8px] text-muted uppercase">prefix: {link.env_prefix}</span>
                      </div>
                      <PermissionGate permission="services.link">
                        <Btn
                          size="xs"
                          variant="ghost"
                          loading={actionLoading === `unlink-${link.id}`}
                          onClick={() => unlinkApp(link.id)}
                        >
                          <Unlink size={12} className="text-accent-red" />
                        </Btn>
                      </PermissionGate>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-mono text-[10px] text-muted text-center py-2">No apps linked yet</p>
              )}

              <PermissionGate permission="services.link">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <NeoSelect
                      value={linkAppId}
                      onChange={setLinkAppId}
                      options={unlinkedApps.map((a) => ({ value: String(a.id), label: a.name }))}
                      placeholder="Select an app to link..."
                    />
                  </div>
                  <div className="w-28">
                    <input
                      type="text"
                      value={linkPrefix}
                      onChange={(e) => setLinkPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                      className="w-full bg-bg border-2 border-fg px-2 py-[7px] font-mono text-[10px] text-fg"
                      placeholder="PREFIX"
                      title="Environment variable prefix"
                    />
                  </div>
                  <Btn
                    size="xs"
                    variant="primary"
                    loading={actionLoading === "link"}
                    onClick={linkApp}
                    disabled={!linkAppId}
                  >
                    <Link2 size={12} /> Link
                  </Btn>
                </div>
              </PermissionGate>
            </div>
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
    </div>
  );
}
