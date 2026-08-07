import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, StatusBadge, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { PausedBanner } from "../../components/paused-banner.tsx";
import { trackOperationInToast, useResourceOperations } from "../../hooks/useOperation.ts";
import { ArrowLeft, Play, Pause, RotateCcw, Trash2 } from "lucide-react";
import { OverviewTab } from "./overview-tab.tsx";
import { LogsTab } from "./logs-tab.tsx";
import { DeploymentsTab } from "./deployments-tab.tsx";
import { ScalingTab } from "./scaling-tab.tsx";
import { WebhooksTab } from "./webhooks-tab.tsx";
import type { AppData, ServerData, ReplicaData, MetricSample, ScalingEvent, DeploymentRecord } from "../../types.ts";
import { useMobileLayout } from "../../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "../../components/mobile-action-sheet.tsx";
import { MoreHorizontal } from "lucide-react";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function AppDetailPage({ appId }: { appId: number }) {
  const isMobile = useMobileLayout();
  const [app, setApp] = useState<AppData | null>(null);
  const [server, setServer] = useState<ServerData | null>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "webhooks">("overview");
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [replicas, setReplicas] = useState<ReplicaData[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const [scalingEvents, setScalingEvents] = useState<ScalingEvent[]>([]);
  const [allServers, setAllServers] = useState<ServerData[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const ops = useResourceOperations(`app:${appId}`, { rehydrateToasts: true });
  const [tail, setTail] = useState(100);
  const [selectedReplicaId, setSelectedReplicaId] = useState<number | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);

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
    if (tab === "logs") { loadReplicas(); loadLogs(); }
    if (tab === "deployments") loadDeployments();
    if (tab === "overview" || tab === "scaling") loadReplicas();
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
  ] as const;

  return (
    <div className={isMobile ? "px-4 pb-5 pt-4 animate-fade-in" : "max-w-4xl mx-auto px-4 py-6 animate-fade-in"}>
      {isMobile ? (
        <div className="mb-5">
          <div className="flex items-start gap-3">
            <button onClick={() => { window.location.hash = "#/"; }} aria-label="Back to dashboard" className="grid h-11 w-11 shrink-0 place-items-center border-2 border-fg bg-bg-raised shadow-neo-sm active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"><ArrowLeft size={18} /></button>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted">App</p>
              <h1 className="mt-0.5 truncate font-mono text-lg font-bold uppercase text-fg">{app.name}</h1>
              <div className="mt-1"><StatusBadge status={app.status} subLabel={app.environment_stale ? "stale environment" : badgeSubLabel} /></div>
            </div>
            <button onClick={() => setMobileActionsOpen(true)} aria-label="App actions" className="grid h-11 w-11 shrink-0 place-items-center rounded-full active:bg-alt"><MoreHorizontal size={23} /></button>
          </div>
          {server && <p className="ml-14 mt-2 truncate font-mono text-[9px] text-muted">{server.name} · {server.ipv4}</p>}
        </div>
      ) : (
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{app.name}</h1>
            <StatusBadge
              status={app.status}
              subLabel={app.environment_stale ? "stale environment" : badgeSubLabel}
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
      )}

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
          actionLoading={actionLoading}
          action={action}
          ops={ops}
        />
      )}

      {tab === "webhooks" && (
        <WebhooksTab
          app={app}
          appId={appId}
          action={action}
          ops={ops}
        />
      )}

      <MobileActionSheet open={isMobile && mobileActionsOpen} onClose={() => setMobileActionsOpen(false)} title={app.name} subtitle={`App · ${app.status}`}>
        <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={<RotateCcw size={19} />} label="Restart" detail="Restart all running replicas" loading={actionLoading === "restart" || ops.isBusyWith("restart_app")} disabled={ops.isBusy} onClick={() => { setMobileActionsOpen(false); action("restart", () => post(`/api/apps/${appId}/restart`)); }} />
        </PermissionGate>
        <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={app.status === "paused" ? <Play size={19} /> : <Pause size={19} />} label={app.status === "paused" ? "Unpause" : "Pause"} detail={app.status === "paused" ? "Resume serving traffic" : "Stop serving traffic without destroying the app"} disabled={ops.isBusy} onClick={() => { const next = app.status === "paused" ? "unpause" : "pause"; setMobileActionsOpen(false); action(next, () => post(`/api/apps/${appId}/${next}`)); }} />
        </PermissionGate>
        <PermissionGate permission="apps.destroy" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={<Trash2 size={19} />} label="Destroy app" detail="Remove containers, DNS records and webhooks" danger loading={actionLoading === "destroy" || ops.isBusyWith("destroy_app")} disabled={ops.isBusy} onClick={async () => {
            if (await confirm("Destroy App", `Permanently destroy "${app.name}"?`, true)) {
              setMobileActionsOpen(false);
              await action("destroy", () => del(`/api/apps/${appId}`));
              window.location.hash = "#/";
            }
          }} />
        </PermissionGate>
      </MobileActionSheet>
    </div>
  );
}
