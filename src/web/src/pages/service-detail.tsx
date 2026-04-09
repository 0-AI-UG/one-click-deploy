import { useState, useEffect, useRef } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, Spinner, showToast, confirm } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import {
  Database, Copy, Check, RotateCcw, Pause, Play, Trash2, Plus, Minus,
  Link2, Unlink, ScrollText, ChevronDown, ChevronRight,
} from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="p-1 text-muted hover:text-fg transition-colors"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
    </button>
  );
}

export function ServiceDetailPage({ serviceId }: { serviceId: number }) {
  const [service, setService] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [apps, setApps] = useState<any[]>([]);
  const [linkAppId, setLinkAppId] = useState<number | null>(null);
  const [linkPrefix, setLinkPrefix] = useState("DATABASE");

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

  useEffect(() => { load(); }, [serviceId]);

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

  const scale = async (delta: number) => {
    const current = service?.instances?.length || 1;
    const target = current + delta;
    if (target < 1) return;
    setActionLoading("scale");
    try {
      await post(`/api/services/${serviceId}/scale`, { instances: target });
      showToast(`Scaled to ${target} instances`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const fetchLogs = async (instanceId?: number) => {
    try {
      const params = instanceId ? `?instance_id=${instanceId}` : "";
      const data = await get(`/api/services/${serviceId}/logs${params}`);
      setLogs(data.logs);
      setShowLogs(true);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const linkApp = async () => {
    if (!linkAppId) return;
    setActionLoading("link");
    try {
      await post(`/api/services/${serviceId}/link/${linkAppId}`, { env_prefix: linkPrefix });
      showToast("Service linked to app", "success");
      setLinkAppId(null);
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
  const unlinkedApps = apps.filter((a: any) => !linkedApps.some((l: any) => l.id === a.id));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Database size={16} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">{service.name}</h1>
          <span className="font-mono text-[9px] text-muted uppercase">{service.service_type} {service.version}</span>
          <StatusBadge status={service.status} />
        </div>
        <div className="flex items-center gap-1">
          <PermissionGate permission="apps.restart">
            <Btn size="xs" variant="ghost" loading={actionLoading === "restart"} onClick={() => action("restart", "Restart")}>
              <RotateCcw size={12} />
            </Btn>
          </PermissionGate>
          <PermissionGate permission="apps.pause">
            {service.status === "paused" ? (
              <Btn size="xs" variant="ghost" loading={actionLoading === "unpause"} onClick={() => action("unpause", "Unpause")}>
                <Play size={12} />
              </Btn>
            ) : (
              <Btn size="xs" variant="ghost" loading={actionLoading === "pause"} onClick={() => action("pause", "Pause")}>
                <Pause size={12} />
              </Btn>
            )}
          </PermissionGate>
          <PermissionGate permission="apps.destroy">
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

      {/* Instances */}
      <Card>
        <div className="px-4 py-2 border-b-2 border-fg bg-alt flex items-center justify-between">
          <span className="font-mono text-[10px] font-bold text-fg uppercase">
            Instances ({instances.length})
          </span>
          <PermissionGate permission="scaling.manage">
            <div className="flex items-center gap-1">
              <Btn size="xs" variant="ghost" loading={actionLoading === "scale"} onClick={() => scale(1)}>
                <Plus size={12} /> Add Replica
              </Btn>
              {instances.length > 1 && (
                <Btn size="xs" variant="ghost" loading={actionLoading === "scale"} onClick={() => scale(-1)}>
                  <Minus size={12} />
                </Btn>
              )}
            </div>
          </PermissionGate>
        </div>
        <div className="divide-y divide-fg/10">
          {instances.map((inst: any) => (
            <div key={inst.id} className="px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] font-bold text-fg">{inst.container_name}</span>
                <span className={`font-mono text-[8px] font-bold uppercase border px-1 py-0.5 ${
                  inst.role === "primary"
                    ? "border-accent-blue text-accent-blue"
                    : "border-muted text-muted"
                }`}>
                  {inst.role}
                </span>
                <StatusBadge status={inst.status} />
                <span className="font-mono text-[9px] text-muted">
                  CPU {inst.cpu_percent?.toFixed(1)}% | MEM {inst.memory_percent?.toFixed(1)}%
                </span>
              </div>
              <Btn size="xs" variant="ghost" onClick={() => fetchLogs(inst.id)}>
                <ScrollText size={12} />
              </Btn>
            </div>
          ))}
        </div>
      </Card>

      {/* Linked Apps */}
      <Card>
        <div className="px-4 py-2 border-b-2 border-fg bg-alt">
          <span className="font-mono text-[10px] font-bold text-fg uppercase">Linked Apps</span>
        </div>
        <div className="p-4 space-y-3">
          {linkedApps.length > 0 ? (
            <div className="divide-y divide-fg/10 border-2 border-fg/20">
              {linkedApps.map((link: any) => (
                <div key={link.id} className="px-3 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link2 size={12} className="text-accent-blue" />
                    <a href={`#/apps/${link.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">
                      {link.name}
                    </a>
                    <span className="font-mono text-[8px] text-muted uppercase">prefix: {link.env_prefix}</span>
                  </div>
                  <PermissionGate permission="apps.env">
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

          <PermissionGate permission="apps.env">
            <div className="flex items-center gap-2">
              <select
                value={linkAppId || ""}
                onChange={(e) => setLinkAppId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="flex-1 bg-bg border-2 border-fg px-2 py-1.5 font-mono text-[10px] text-fg"
              >
                <option value="">Select an app to link...</option>
                {unlinkedApps.map((app: any) => (
                  <option key={app.id} value={app.id}>{app.name}</option>
                ))}
              </select>
              <input
                type="text"
                value={linkPrefix}
                onChange={(e) => setLinkPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                className="w-28 bg-bg border-2 border-fg px-2 py-1.5 font-mono text-[10px] text-fg"
                placeholder="PREFIX"
                title="Environment variable prefix"
              />
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

      {/* Logs */}
      {showLogs && (
        <Card>
          <div className="px-4 py-2 border-b-2 border-fg bg-alt flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold text-fg uppercase">Logs</span>
            <Btn size="xs" variant="ghost" onClick={() => setShowLogs(false)}>Close</Btn>
          </div>
          <pre className="p-4 font-mono text-[10px] text-fg whitespace-pre-wrap max-h-96 overflow-auto bg-black/5">
            {logs || "No logs available"}
          </pre>
        </Card>
      )}
    </div>
  );
}
