import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, StatusBadge, Spinner, showToast, confirm, CopyButton } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { ArrowLeft, RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink } from "lucide-react";
import { OverviewTab } from "./overview-tab.tsx";
import { LogsTab } from "./logs-tab.tsx";
import { DeploymentsTab } from "./deployments-tab.tsx";
import { ScalingTab } from "./scaling-tab.tsx";
import { WebhooksTab } from "./webhooks-tab.tsx";
import { SettingsTab } from "./settings-tab.tsx";
import type { AppData, ServerData, ReplicaData, MetricSample, ScalingEvent, DeploymentRecord } from "../../types.ts";

export function AppDetailPage({ appId }: { appId: number }) {
  const [app, setApp] = useState<AppData | null>(null);
  const [server, setServer] = useState<ServerData | null>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "webhooks" | "settings">("overview");
  const [nameEdit, setNameEdit] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [portEdit, setPortEdit] = useState<number>(0);
  const [envEdit, setEnvEdit] = useState<{ key: string; value: string }[]>([]);
  const [volumeForm, setVolumeForm] = useState<{ size: number; mount_path: string }>({ size: 10, mount_path: "/data" });
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [replicas, setReplicas] = useState<ReplicaData[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const [scalingEvents, setScalingEvents] = useState<ScalingEvent[]>([]);
  const [allServers, setAllServers] = useState<ServerData[]>([]);
  const [policy, setPolicy] = useState<{
    autoscale_enabled: boolean;
    min_replicas: number;
    max_replicas: number;
    cpu_threshold: number;
    mem_threshold: number;
    cooldown: number;
    scale_to_zero_after: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tail, setTail] = useState(100);
  const [selectedReplicaId, setSelectedReplicaId] = useState<number | null>(null);
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
      const qs = `tail=${tail}${selectedReplicaId != null ? `&replica_id=${selectedReplicaId}` : ""}`;
      const res = await get(`/api/apps/${appId}/logs?${qs}`);
      setLogs(res.logs || res.error || "No logs available");
    } catch (err: any) {
      setLogs(err.message);
    }
  };

  const loadDeployments = async () => {
    try {
      setDeployments(await get(`/api/apps/${appId}/deployments`));
    } catch (err) {
      console.error("Failed to load deployments:", err);
    }
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
    } catch (err) {
      console.error("Failed to load replicas/metrics:", err);
    }
  };

  useEffect(() => {
    if (tab === "scaling" && app && !policy) {
      setPolicy({
        autoscale_enabled: !!app.autoscale_enabled,
        min_replicas: app.min_replicas ?? 1,
        max_replicas: app.max_replicas ?? 3,
        cpu_threshold: app.autoscale_cpu_threshold ?? 70,
        mem_threshold: app.autoscale_mem_threshold ?? 80,
        cooldown: app.autoscale_cooldown ?? 300,
        scale_to_zero_after: app.scale_to_zero_after ?? 300,
      });
    }
  }, [tab, app]);

  useEffect(() => {
    if (tab === "logs") { loadReplicas(); loadLogs(); }
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

  useEffect(() => {
    if (tab === "logs" && selectedReplicaId != null) loadLogs();
  }, [selectedReplicaId]);

  const action = async (name: string, fn: () => Promise<unknown>) => {
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

  // Cold-start ETA sub-label for the state badge. Scale-to-zero is a
  // `docker stop` on the tenant host, so wake is always ~1s.
  let badgeSubLabel: string | undefined;
  if (app.status === "sleeping") {
    badgeSubLabel = "wakes in ~1s";
  } else if (app.status === "waking") {
    badgeSubLabel = "starting...";
  }

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
    { key: "deployments", label: "Deployments" },
    { key: "scaling", label: "Scaling" },
    { key: "webhooks", label: "Webhooks" },
    { key: "settings", label: "Settings" },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{app.name}</h1>
            <StatusBadge status={app.status} subLabel={badgeSubLabel} />
          </div>
          {app.domain && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="font-mono text-[9px] text-accent-blue font-bold">https://{app.domain}</span>
              <CopyButton text={`https://${app.domain}`} />
              <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="p-1 text-muted hover:text-fg transition-colors">
                <ExternalLink size={12} />
              </a>
              <span className="font-mono text-[9px] text-muted ml-1">— {server?.name} ({server?.ipv4})</span>
            </div>
          )}
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
          >{t.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          app={app}
          appId={appId}
          replicas={replicas}
          metricsHistory={metricsHistory}
          scalingEvents={scalingEvents}
          allServers={allServers}
          setReplicas={setReplicas}
        />
      )}

      {tab === "logs" && (
        <LogsTab
          logs={logs}
          tail={tail}
          setTail={setTail}
          loadLogs={loadLogs}
          replicas={replicas}
          selectedReplicaId={selectedReplicaId}
          setSelectedReplicaId={setSelectedReplicaId}
        />
      )}

      {tab === "deployments" && (
        <DeploymentsTab
          appId={appId}
          deployments={deployments}
          action={action}
        />
      )}

      {tab === "scaling" && (
        <ScalingTab
          app={app}
          appId={appId}
          replicas={replicas}
          policy={policy}
          setPolicy={setPolicy}
          actionLoading={actionLoading}
          action={action}
          loadReplicas={loadReplicas}
          load={load}
        />
      )}

      {tab === "webhooks" && (
        <WebhooksTab
          app={app}
          appId={appId}
          webhookForm={webhookForm}
          setWebhookForm={setWebhookForm}
          actionLoading={actionLoading}
          action={action}
        />
      )}

      {tab === "settings" && (
        <SettingsTab
          app={app}
          appId={appId}
          nameEdit={nameEdit}
          setNameEdit={setNameEdit}
          authPassword={authPassword}
          setAuthPassword={setAuthPassword}
          portEdit={portEdit}
          setPortEdit={setPortEdit}
          envEdit={envEdit}
          setEnvEdit={setEnvEdit}
          volumeForm={volumeForm}
          setVolumeForm={setVolumeForm}
          actionLoading={actionLoading}
          action={action}
        />
      )}
    </div>
  );
}
