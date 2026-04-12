import { useState, useEffect, useRef } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, EmptyState, Spinner, showToast, confirm, CopyButton } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Globe, GitBranch, RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink, ScrollText, Check, Database, Box } from "lucide-react";

type AppData = {
  id: number; name: string; domain: string; git_repo: string; status: string;
  deploy_mode: string; container_port: number; webhook_enabled: number;
  desired_replicas: number; volume_id: string;
};
type ServiceData = {
  id: number; name: string; service_type: string; version: string; status: string;
  linked_apps: Array<{ id: number; name: string }>;
};
type DashboardData = { apps: AppData[]; services: ServiceData[] };

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ apps: [], services: [] });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);

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

  const appAction = async (action: string, appId: number, label: string, body?: Record<string, unknown>) => {
    const key = `${action}-${appId}`;
    setActionLoading(key);
    try {
      if (action === "delete") {
        await del(`/api/apps/${appId}`);
      } else {
        await post(`/api/apps/${appId}/${action}`, body);
      }
      showToast(`${label} successful`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const svcAction = async (action: string, svcId: number, label: string) => {
    const key = `svc-${action}-${svcId}`;
    setActionLoading(key);
    try {
      if (action === "delete") {
        await del(`/api/services/${svcId}`);
      } else {
        await post(`/api/services/${svcId}/${action}`);
      }
      showToast(`${label} successful`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  const { apps, services } = data;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
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
                {apps.map((app) => (
                  <div key={app.id} className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors">
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
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => appAction("restart", app.id, "Restart"))}>
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
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => appAction("unpause", app.id, "Unpause"))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                            </Btn>
                          );
                        })() : (() => {
                          const k = `pause-${app.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => appAction("pause", app.id, "Pause"))}>
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
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => appAction("redeploy", app.id, "Redeploy"))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <RefreshCw size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.destroy">
                        <Btn
                          size="xs"
                          variant="ghost"
                          loading={actionLoading === `delete-${app.id}`}
                          onClick={async () => {
                            if (await confirm("Destroy App", `Permanently destroy "${app.name}"? This removes all containers, DNS records, and webhooks.`, true)) {
                              appAction("delete", app.id, "Destroy");
                            }
                          }}
                        ><Trash2 size={12} className="text-accent-red" /></Btn>
                      </PermissionGate>
                    </div>
                  </div>
                ))}
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
                {services.map((svc) => (
                  <div key={svc.id} className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Database size={10} className="text-muted" />
                        <a href={`#/services/${svc.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{svc.name}</a>
                      </div>
                      <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{svc.service_type}</span>
                      <span className="font-mono text-[9px] text-muted">{svc.version}</span>
                      <StatusBadge status={svc.status} />
                      {svc.linked_apps.length > 0 && (
                        <span className="font-mono text-[8px] text-muted">
                          linked to {svc.linked_apps.map((a) => a.name).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="apps.logs">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/services/${svc.id}`; }}><ScrollText size={12} /></Btn>
                      </PermissionGate>
                      <PermissionGate permission="apps.restart">
                        {(() => {
                          const k = `svc-restart-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => svcAction("restart", svc.id, "Restart"))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <RotateCcw size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.pause">
                        {svc.status === "paused" ? (() => {
                          const k = `svc-unpause-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => svcAction("unpause", svc.id, "Unpause"))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                            </Btn>
                          );
                        })() : (() => {
                          const k = `svc-pause-${svc.id}`;
                          const armed = confirmKey === k;
                          return (
                            <Btn size="xs" variant="ghost" loading={actionLoading === k} onClick={() => armOrRun(k, () => svcAction("pause", svc.id, "Pause"))}>
                              {armed ? <Check size={12} className="text-accent-blue" /> : <Pause size={12} />}
                            </Btn>
                          );
                        })()}
                      </PermissionGate>
                      <PermissionGate permission="apps.destroy">
                        <Btn
                          size="xs"
                          variant="ghost"
                          loading={actionLoading === `svc-delete-${svc.id}`}
                          onClick={async () => {
                            if (await confirm("Destroy Service", `Permanently destroy "${svc.name}"? This removes all containers, volumes, and data.`, true)) {
                              svcAction("delete", svc.id, "Destroy");
                            }
                          }}
                        ><Trash2 size={12} className="text-accent-red" /></Btn>
                      </PermissionGate>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
