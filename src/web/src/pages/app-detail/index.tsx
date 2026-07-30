import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, StatusBadge, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { PausedBanner } from "../../components/paused-banner.tsx";
import { trackOperationInToast, useResourceOperations } from "../../hooks/useOperation.ts";
import { ArrowLeft, RefreshCw, Play, Pause, RotateCcw, Trash2 } from "lucide-react";
import { OverviewTab } from "./overview-tab.tsx";
import { LogsTab } from "./logs-tab.tsx";
import { DeploymentsTab } from "./deployments-tab.tsx";
import { ScalingTab } from "./scaling-tab.tsx";
import { WebhooksTab } from "./webhooks-tab.tsx";
import { SettingsTab, type IngressForm } from "./settings-tab.tsx";
import type { AppData, ServerData, ReplicaData, MetricSample, ScalingEvent, DeploymentRecord } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function AppDetailPage({ appId }: { appId: number }) {
  const [app, setApp] = useState<AppData | null>(null);
  const [server, setServer] = useState<ServerData | null>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "webhooks" | "settings">("overview");
  const [nameEdit, setNameEdit] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [portEdit, setPortEdit] = useState<number>(0);
  const [memEdit, setMemEdit] = useState<number>(0);
  const [cpuEdit, setCpuEdit] = useState<number>(0);
  const [volumeForm, setVolumeForm] = useState<{ size: number; mount_path: string }>({ size: 10, mount_path: "/data" });
  const [ingressForm, setIngressForm] = useState<IngressForm>({ sticky: false, rate_limit_rps: 0, ip_allowlist: "", health_check_path: "", compress: false, public_protocol: "off", public_port: "", auth_enabled: false, auth_password: "", internal_protocol: "http", health_check: true });
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
    req_threshold: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const ops = useResourceOperations(`app:${appId}`, { rehydrateToasts: true });
  const [tail, setTail] = useState(100);
  const [selectedReplicaId, setSelectedReplicaId] = useState<number | null>(null);
  const [webhookForm, setWebhookForm] = useState<{ branch: string; path: string; waitForCi: boolean; stagingEnvId: number | null }>({ branch: "main", path: "", waitForCi: false, stagingEnvId: null });

  const load = async () => {
    try {
      const servers: ServerData[] = await get("/api/servers");
      for (const s of servers) {
        const found = s.apps.find((a) => a.id === appId);
        if (found) { setApp(found); setServer(s); break; }
      }
    } catch (err) {
      showToast(errMessage(err), "error");
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
    } catch (err) {
      setLogs(errMessage(err));
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
        req_threshold: app.autoscale_req_threshold ?? 0,
      });
    }
  }, [tab, app]);

  useEffect(() => {
    if (tab === "logs") { loadReplicas(); loadLogs(); }
    if (tab === "deployments") loadDeployments();
    if (tab === "overview" || tab === "scaling") loadReplicas();
    if (tab === "settings" && app) {
      setNameEdit(app.name || "");
      setIsPublic(!!app.public);
      setPortEdit(app.container_port || 0);
      setMemEdit(app.memory_mb || 0);
      setCpuEdit(app.cpu_limit || 0);
      setIngressForm({
        sticky: !!app.sticky,
        rate_limit_rps: app.rate_limit_rps || 0,
        ip_allowlist: app.ip_allowlist || "",
        health_check_path: app.health_check_path || "",
        compress: !!app.compress,
        public_protocol: app.public_port != null ? (app.public_protocol === "udp" ? "udp" : "tcp") : "off",
        public_port: app.public_port != null ? String(app.public_port) : "",
        // Password is write-only: we only know whether auth is on, never the
        // value. Blank field + enabled = keep current password.
        auth_enabled: !!app.auth_enabled,
        auth_password: "",
        internal_protocol: app.internal_protocol === "tcp" ? "tcp" : "http",
        health_check: !!(app.health_check ?? 1),
      });
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
      const result = await fn();
      const opId = result && typeof result === "object" && "op_id" in result
        ? (result as { op_id?: number }).op_id ?? null
        : null;
      if (opId) {
        trackOperationInToast(opId, `${name.charAt(0).toUpperCase() + name.slice(1)} app`);
        ops.track(opId);
      } else {
        showToast(`${name} successful`, "success");
      }
      load();
    } catch (err) {
      showToast(errMessage(err), "error");
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
  ] as const;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{app.name}</h1>
            <StatusBadge
              status={app.status}
              subLabel={app.environment_stale ? "stale environment — redeploy required" : badgeSubLabel}
            />
          </div>
          {server && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="font-mono text-[9px] text-muted">{server.name} ({server.ipv4})</span>
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" loading={actionLoading === "restart" || ops.isBusyWith("restart_app")} disabled={ops.isBusy} onClick={() => action("restart", () => post(`/api/apps/${appId}/restart`))}>
              <RotateCcw size={12} /> Restart
            </Btn>
          </PermissionGate>
          <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
            {app.status === "paused" ? (
              <Btn size="xs" loading={actionLoading === "unpause" || ops.isBusyWith("unpause_app")} disabled={ops.isBusy} onClick={() => action("unpause", () => post(`/api/apps/${appId}/unpause`))}>
                <Play size={12} /> Unpause
              </Btn>
            ) : (
              <Btn size="xs" loading={actionLoading === "pause" || ops.isBusyWith("pause_app")} disabled={ops.isBusy} onClick={() => action("pause", () => post(`/api/apps/${appId}/pause`))}>
                <Pause size={12} /> Pause
              </Btn>
            )}
          </PermissionGate>
          <PermissionGate permission="apps.deploy" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" variant="primary" loading={actionLoading === "redeploy" || ops.isBusyWith("redeploy")} disabled={ops.isBusy} onClick={() => action("redeploy", () => post(`/api/apps/deploy`, {
              app_name: app.name,
              git_repo: app.git_repo,
              container_port: app.container_port,
            }))}>
              <RefreshCw size={12} /> Deploy latest code
            </Btn>
          </PermissionGate>
          <PermissionGate permission="apps.destroy" appId={appId} environmentId={app.environment_id}>
            <Btn
              size="xs" variant="danger"
              loading={actionLoading === "destroy" || ops.isBusyWith("destroy_app")}
              disabled={ops.isBusy}
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

      {app.status === "paused" && (
        <PausedBanner message="App is paused; containers are frozen and not serving traffic">
          <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" loading={actionLoading === "unpause" || ops.isBusyWith("unpause_app")} disabled={ops.isBusy} onClick={() => action("unpause", () => post(`/api/apps/${appId}/unpause`))}>
              <Play size={12} /> Unpause
            </Btn>
          </PermissionGate>
        </PausedBanner>
      )}

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab
          app={app}
          appId={appId}
          replicas={replicas}
          metricsHistory={metricsHistory}
          allServers={allServers}
          setReplicas={setReplicas}
          ops={ops}
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
          ops={ops}
        />
      )}

      {tab === "scaling" && (
        <ScalingTab
          app={app}
          appId={appId}
          replicas={replicas}
          scalingEvents={scalingEvents}
          policy={policy}
          setPolicy={setPolicy}
          actionLoading={actionLoading}
          action={action}
          loadReplicas={loadReplicas}
          load={load}
          ops={ops}
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
          ops={ops}
        />
      )}

      {tab === "settings" && (
        <SettingsTab
          app={app}
          appId={appId}
          nameEdit={nameEdit}
          setNameEdit={setNameEdit}
          isPublic={isPublic}
          setIsPublic={setIsPublic}
          portEdit={portEdit}
          setPortEdit={setPortEdit}
          memEdit={memEdit}
          setMemEdit={setMemEdit}
          cpuEdit={cpuEdit}
          setCpuEdit={setCpuEdit}
          volumeForm={volumeForm}
          setVolumeForm={setVolumeForm}
          ingressForm={ingressForm}
          setIngressForm={setIngressForm}
          actionLoading={actionLoading}
          action={action}
          ops={ops}
        />
      )}
    </div>
  );
}
