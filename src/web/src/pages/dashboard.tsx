import { useState, useEffect, useRef } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, EmptyState, Spinner, showToast, confirm, CopyButton } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { Globe, GitBranch, RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink, ScrollText, Check, Database, Box } from "lucide-react";

type AppData = {
  id: number; name: string; domain: string; git_repo: string; status: string;
  deploy_mode: string; container_port: number; webhook_enabled: number;
  desired_replicas: number; volume_id: string;
};
type ServiceData = {
  id: number; name: string; service_type: string; version: string; status: string;
  linked_environments: Array<{ id: number; name: string }>;
};
type DashboardData = { apps: AppData[]; services: ServiceData[] };

const APP_OP_KINDS = new Set([
  "restart_app", "pause_app", "unpause_app", "redeploy", "destroy_app",
]);
const SVC_OP_KINDS = new Set([
  "restart_service", "pause_service", "unpause_service", "destroy_service",
]);

const APP_OP_LABELS: Record<string, string> = {
  restart: "Restarting app",
  pause: "Pausing app",
  unpause: "Unpausing app",
  redeploy: "Redeploying app",
  delete: "Destroying app",
};
const SVC_OP_LABELS: Record<string, string> = {
  restart: "Restarting service",
  pause: "Pausing service",
  unpause: "Unpausing service",
  delete: "Destroying service",
};
const APP_ACTION_TO_KIND: Record<string, string> = {
  restart: "restart_app",
  pause: "pause_app",
  unpause: "unpause_app",
  redeploy: "redeploy",
  delete: "destroy_app",
};
const SVC_ACTION_TO_KIND: Record<string, string> = {
  restart: "restart_service",
  pause: "pause_service",
  unpause: "unpause_service",
  delete: "destroy_service",
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ apps: [], services: [] });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);

  const ops = useActiveOperations(
    (op) => APP_OP_KINDS.has(op.kind) || SVC_OP_KINDS.has(op.kind),
    { rehydrateToasts: true },
  );

  const armOrRun = (key: string, run: () => void) => {
    if (confirmKey === key) {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(null);
      run();
    } else {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(key);
      confirmTimeoutRef.current = window.setTimeout(() => setConfirmKey(null), 3000);
    }
  };

  const load = async () => {
    try {
      setData(await get("/api/dashboard"));
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Refetch dashboard state whenever the set of active ops changes — catches
  // both enqueue (op appears) and terminal (op drops out after ~2s linger).
  const activeSig = ops.active.map((o) => `${o.id}:${o.status}`).join(",");
  useEffect(() => {
    if (!loading) load();
  }, [activeSig]);

  const appAction = async (action: string, appId: number, body?: Record<string, unknown>) => {
    const key = `${action}-${appId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/apps/${appId}`) as { op_id?: number }
        : await post(`/api/apps/${appId}/${action}`, body) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, APP_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const svcAction = async (action: string, svcId: number) => {
    const key = `svc-${action}-${svcId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/services/${svcId}`) as { op_id?: number }
        : await post(`/api/services/${svcId}/${action}`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, SVC_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const appBusyKind = (appId: number) => ops.byResourceKey(`app:${appId}`)?.kind;
  const svcBusyKind = (svcId: number) => ops.byResourceKey(`service:${svcId}`)?.kind;

  const isAppActionLoading = (appId: number, action: string) => {
    const k = `${action}-${appId}`;
    return actionLoading === k || appBusyKind(appId) === APP_ACTION_TO_KIND[action];
  };
  const isSvcActionLoading = (svcId: number, action: string) => {
    const k = `svc-${action}-${svcId}`;
    return actionLoading === k || svcBusyKind(svcId) === SVC_ACTION_TO_KIND[action];
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  const { apps, services } = data;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Dashboard</h1>
          <p className="text-[10px] text-muted font-mono mt-0.5">
            {apps.length} app{apps.length !== 1 ? "s" : ""}
            {services.length > 0 && `, ${services.length} service${services.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={load} variant="ghost"><RefreshCw size={13} /> Refresh</Btn>
          <PermissionGate permission="apps.deploy">
            <Btn onClick={() => { window.location.hash = "#/deploy"; }} variant="ghost"><Database size={13} /> New Service</Btn>
            <Btn onClick={() => { window.location.hash = "#/deploy"; }} variant="primary">Deploy New App</Btn>
          </PermissionGate>
        </div>
      </div>

      {apps.length === 0 && services.length === 0 ? (
        <EmptyState message="Nothing deployed yet. Deploy your first app or service to get started." icon={Box} />
      ) : (
        <>
          {/* Apps */}
          {apps.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b-2 border-fg flex items-center gap-2 bg-alt">
                <Box size={14} className="text-fg" />
                <span className="font-mono text-[10px] font-bold text-fg uppercase">Apps</span>
              </div>
              <div className="divide-y divide-fg/10">
                {apps.map((app) => {
                  const rowBusy = !!appBusyKind(app.id);
                  const disableRow = ops.isBusy;
                  return (
                  <div key={app.id} className={`px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors ${app.status === "paused" ? "opacity-50" : ""} ${rowBusy ? "bg-alt/30" : ""}`}>
                    <div className="flex items-center gap-4 min-w-0">
                      <a href={`#/apps/${app.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{app.name}</a>
                      {app.domain && (
                        <span className="flex items-center gap-1 text-[9px] font-mono text-muted">
                          <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="flex items-center gap-1 hover:text-fg transition-colors">
                            <Globe size={10} />{app.domain}<ExternalLink size={8} />
                          </a>
                          <CopyButton text={`https://${app.domain}`} size={10} />
                        </span>
                      )}
                      <StatusBadge status={app.status} />
                      {app.webhook_enabled ? <span title="Webhook active"><GitBranch size={10} className="text-accent" /></span> : null}
                      {app.desired_replicas > 1 && (
                        <span className="font-mono text-[9px] font-bold border border-fg px-1">{app.desired_replicas}x</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="apps.logs">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/apps/${app.id}`; }}><ScrollText size={12} /></Btn>
                      </PermissionGate>
                      <PermissionGate permission="apps.restart">
                        {(() => {
                          const k = `restart-${app.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "restart")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("restart", app.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <RotateCcw size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.pause">
                        {app.status === "paused" ? (() => {
                          const k = `unpause-${app.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "unpause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("unpause", app.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                            </Btn>
                          );
                        })() : (() => {
                          const k = `pause-${app.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "pause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("pause", app.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Pause size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.redeploy">
                        {(() => {
                          const k = `redeploy-${app.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "redeploy")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("redeploy", app.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <RefreshCw size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.destroy">
                        <Btn
                          size="xs"
                          variant="ghost"
                          loading={isAppActionLoading(app.id, "delete")}
                          disabled={disableRow}
                          onClick={async () => {
                            if (await confirm("Destroy App", `Permanently destroy "${app.name}"? This removes all containers, DNS records, and webhooks.`, true)) {
                              appAction("delete", app.id);
                            }
                          }}
                        ><Trash2 size={12} className="text-accent-red" /></Btn>
                      </PermissionGate>
                    </div>
                  </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Services */}
          {services.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b-2 border-fg flex items-center gap-2 bg-alt">
                <Database size={14} className="text-fg" />
                <span className="font-mono text-[10px] font-bold text-fg uppercase">Services</span>
              </div>
              <div className="divide-y divide-fg/10">
                {services.map((svc) => {
                  const rowBusy = !!svcBusyKind(svc.id);
                  const disableRow = ops.isBusy;
                  return (
                  <div key={svc.id} className={`px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors ${svc.status === "paused" ? "opacity-50" : ""} ${rowBusy ? "bg-alt/30" : ""}`}>
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Database size={10} className="text-muted" />
                        <a href={`#/services/${svc.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{svc.name}</a>
                      </div>
                      <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{svc.service_type}</span>
                      <span className="font-mono text-[9px] text-muted">{svc.version}</span>
                      <StatusBadge status={svc.status} />
                      {svc.linked_environments.length > 0 && (
                        <span className="font-mono text-[8px] text-muted">
                          injected into {svc.linked_environments.map((e) => e.name).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="services.logs">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/services/${svc.id}`; }}><ScrollText size={12} /></Btn>
                      </PermissionGate>
                      <PermissionGate permission="services.manage">
                        {(() => {
                          const k = `svc-restart-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "restart")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("restart", svc.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <RotateCcw size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="services.manage">
                        {svc.status === "paused" ? (() => {
                          const k = `svc-unpause-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "unpause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("unpause", svc.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                            </Btn>
                          );
                        })() : (() => {
                          const k = `svc-pause-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "pause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("pause", svc.id))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Pause size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="services.destroy">
                        <Btn
                          size="xs"
                          variant="ghost"
                          loading={isSvcActionLoading(svc.id, "delete")}
                          disabled={disableRow}
                          onClick={async () => {
                            if (await confirm("Destroy Service", `Permanently destroy "${svc.name}"? This removes all containers, volumes, and data.`, true)) {
                              svcAction("delete", svc.id);
                            }
                          }}
                        ><Trash2 size={12} className="text-accent-red" /></Btn>
                      </PermissionGate>
                    </div>
                  </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
