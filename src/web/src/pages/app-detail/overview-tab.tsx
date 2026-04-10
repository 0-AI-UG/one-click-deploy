import { get, post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, showToast, Table, CopyButton } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { RefreshCw, ExternalLink, Server as ServerIcon, History, Terminal } from "lucide-react";
import { Sparkline } from "./shared.tsx";

interface OverviewTabProps {
  app: any;
  appId: number;
  replicas: any[];
  metricsHistory: any[];
  scalingEvents: any[];
  allServers: any[];
  setReplicas: (r: any[]) => void;
}

export function OverviewTab({ app, appId, replicas, metricsHistory, scalingEvents, allServers, setReplicas }: OverviewTabProps) {
  const envVars = app.env_vars ? (typeof app.env_vars === "string" ? JSON.parse(app.env_vars) : app.env_vars) : {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
          <div className="space-y-2 text-[10px] font-mono">
            {app.domain && (
              <div className="flex justify-between items-center"><span className="text-muted">URL</span><span className="flex items-center gap-1"><a href={`https://${app.domain}`} target="_blank" rel="noopener" className="text-accent-blue font-bold hover:underline">https://{app.domain}</a><CopyButton text={`https://${app.domain}`} /><a href={`https://${app.domain}`} target="_blank" rel="noopener" className="p-1 text-muted hover:text-fg"><ExternalLink size={10} /></a></span></div>
            )}
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
                  <td className="py-2 px-3 text-[9px]">
                    <div className="text-fg-dim">{srv?.name || `srv#${r.server_id}`}</div>
                  </td>
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
  );
}
