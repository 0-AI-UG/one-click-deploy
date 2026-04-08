import { useState, useEffect } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, EmptyState, Spinner, showToast, confirm } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Server, Globe, GitBranch, RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink, ScrollText, Terminal } from "lucide-react";

type AppData = {
  id: number; name: string; domain: string; git_repo: string; status: string;
  deploy_mode: string; container_port: number; webhook_enabled: number;
  desired_replicas: number; volume_id: string;
};
type ServerData = {
  id: number; name: string; ipv4: string; type: string; location: string; status: string;
  ssh_host_key: string; apps: AppData[];
};

export function DashboardPage() {
  const [servers, setServers] = useState<ServerData[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await get("/api/servers");
      setServers(data);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const appAction = async (action: string, appId: number, label: string, body?: any) => {
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

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  const allApps = servers.flatMap((s) => s.apps);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Dashboard</h1>
          <p className="text-[10px] text-muted font-mono mt-0.5">{servers.length} server{servers.length !== 1 ? "s" : ""}, {allApps.length} app{allApps.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={load} variant="ghost"><RefreshCw size={13} /> Refresh</Btn>
          <PermissionGate permission="apps.deploy">
            <Btn onClick={() => { window.location.hash = "#/deploy"; }} variant="primary">Deploy New App</Btn>
          </PermissionGate>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState message="No servers yet. Deploy your first app to get started." icon={Server} />
      ) : (
        servers.map((server) => (
          <Card key={server.id} className="overflow-hidden">
            <div className="px-4 py-3 border-b-2 border-fg flex items-center justify-between bg-alt">
              <div className="flex items-center gap-3">
                <Server size={14} className="text-fg" />
                <span className="font-mono text-[10px] font-bold text-fg uppercase">{server.name}</span>
                <span className="font-mono text-[9px] text-muted">{server.ipv4}</span>
                <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{server.type}</span>
                <span className="font-mono text-[9px] text-muted">{server.location}</span>
              </div>
              <div className="flex items-center gap-2">
                <PermissionGate permission="terminal.access">
                  <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/server/${server.id}`; }}>
                    <Terminal size={12} /> Shell
                  </Btn>
                </PermissionGate>
                <StatusBadge status={server.status} />
              </div>
            </div>
            {server.apps.length === 0 ? (
              <div className="px-4 py-6 text-center text-[10px] text-muted font-mono uppercase tracking-wider">No apps on this server</div>
            ) : (
              <div className="divide-y divide-fg/10">
                {server.apps.map((app) => (
                  <div key={app.id} className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <a href={`#/apps/${app.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{app.name}</a>
                      {app.domain && (
                        <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-[9px] font-mono text-muted hover:text-fg transition-colors">
                          <Globe size={10} />{app.domain}<ExternalLink size={8} />
                        </a>
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
                        <Btn size="xs" variant="ghost" loading={actionLoading === `restart-${app.id}`} onClick={() => appAction("restart", app.id, "Restart")}>
                          <RotateCcw size={12} />
                        </Btn>
                      </PermissionGate>
                      <PermissionGate permission="apps.pause">
                        {app.status === "paused" ? (
                          <Btn size="xs" variant="ghost" loading={actionLoading === `unpause-${app.id}`} onClick={() => appAction("unpause", app.id, "Unpause")}>
                            <Play size={12} />
                          </Btn>
                        ) : (
                          <Btn size="xs" variant="ghost" loading={actionLoading === `pause-${app.id}`} onClick={() => appAction("pause", app.id, "Pause")}>
                            <Pause size={12} />
                          </Btn>
                        )}
                      </PermissionGate>
                      <PermissionGate permission="apps.redeploy">
                        <Btn size="xs" variant="ghost" loading={actionLoading === `redeploy-${app.id}`} onClick={() => appAction("redeploy", app.id, "Redeploy")}>
                          <RefreshCw size={12} />
                        </Btn>
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
            )}
          </Card>
        ))
      )}
    </div>
  );
}
