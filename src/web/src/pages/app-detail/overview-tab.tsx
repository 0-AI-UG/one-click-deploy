import { useState, useRef, useEffect } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, showToast, Spinner, Table, CopyButton } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { RefreshCw, ExternalLink, Server as ServerIcon, Terminal, ArrowRightLeft } from "lucide-react";
import { Sparkline } from "./shared.tsx";
import type { AppData, ReplicaData, MetricSample, ServerData } from "../../types.ts";

interface OverviewTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  metricsHistory: MetricSample[];
  allServers: ServerData[];
  setReplicas: (r: ReplicaData[]) => void;
}

type MigratePoll = {
  status: "running" | "done" | "error";
  events: Array<{ seq: number; ts: string; step: string; detail: string }>;
  last_seq: number;
  result: { ok: boolean; error?: string } | null;
};

export function OverviewTab({ app, appId, replicas, metricsHistory, allServers, setReplicas }: OverviewTabProps) {
  const internalUrl = `http://${app.name}.ocd.internal:8080`;
  const [migratingId, setMigratingId] = useState<number | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<Record<number, string>>({});
  const [migrateProgress, setMigrateProgress] = useState("");
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const readyServers = allServers.filter((s) => s.type); // servers from resources have type

  const handleMigrate = async (replicaId: number) => {
    const targetId = migrateTarget[replicaId];
    if (!targetId) { showToast("Select a target server", "error"); return; }
    setMigratingId(replicaId);
    setMigrateProgress("Starting migration...");
    try {
      const res = await post(`/api/apps/${appId}/replicas/${replicaId}/migrate`, {
        target_server_id: parseInt(targetId, 10),
      }) as { deployment_id: number };

      // Poll progress
      let since = 0;
      while (aliveRef.current) {
        let resp: MigratePoll;
        try {
          resp = await get(`/api/deploy-jobs/${res.deployment_id}?since=${since}`) as MigratePoll;
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (!aliveRef.current) return;
        if (resp.events.length > 0) {
          setMigrateProgress(resp.events[resp.events.length - 1].detail || resp.events[resp.events.length - 1].step);
          since = resp.last_seq;
        }
        if (resp.status !== "running") {
          if (resp.result && !resp.result.ok) throw new Error(resp.result.error || "Migration failed");
          break;
        }
      }
      showToast("Replica migrated", "success");
      setReplicas(await get(`/api/apps/${appId}/metrics`));
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setMigratingId(null);
      setMigrateProgress("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="flex justify-between"><span className="text-muted">Git Repo</span><span className="text-fg font-bold">{app.git_repo}</span></div>
            <div className="flex justify-between"><span className="text-muted">Deploy Mode</span><span className="text-fg">{app.deploy_mode}</span></div>
            <div className="flex justify-between"><span className="text-muted">Container Port</span><span className="text-fg">{app.container_port}</span></div>
            {replicas[0]?.host_port != null && (
              <div className="flex justify-between"><span className="text-muted">Host Port</span><span className="text-fg">{replicas[0].host_port}</span></div>
            )}
            {app.volume_id && <div className="flex justify-between"><span className="text-muted">Volume</span><span className="text-fg">{app.volume_mount}</span></div>}
            {app.auth_password && <div className="flex justify-between"><span className="text-muted">Auth</span><span className="text-accent-amber font-bold">Password protected</span></div>}
            {app.deployed_by_username && <div className="flex justify-between"><span className="text-muted">Last deployed by</span><span className="text-fg">{app.deployed_by_username}</span></div>}
            {app.environment_name && <div className="flex justify-between"><span className="text-muted">Environment</span><a href="#/environments" className="text-fg font-bold hover:underline">{app.environment_name}</a></div>}
          </div>
        </Card>
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Connection</h3>
          <div className="space-y-2 text-[10px] font-mono">
            {app.domain && app.public ? (
              <div className="flex justify-between items-center"><span className="text-muted">Public URL</span><span className="flex items-center gap-1"><a href={`https://${app.domain}`} target="_blank" rel="noopener" className="text-accent-blue font-bold hover:underline">https://{app.domain}</a><CopyButton text={`https://${app.domain}`} /><a href={`https://${app.domain}`} target="_blank" rel="noopener" className="p-1 text-muted hover:text-fg"><ExternalLink size={10} /></a></span></div>
            ) : (
              <div className="flex justify-between items-center"><span className="text-muted">Public Access</span><span className="text-fg-dim font-bold">Disabled</span></div>
            )}
            <div className="flex justify-between items-center" title="Reachable from other apps on the private network. Set this in env vars when one app needs to call another.">
              <span className="text-muted">Internal URL</span>
              <span className="flex items-center gap-1">
                <span className="text-fg font-bold">{internalUrl}</span>
                <CopyButton text={internalUrl} />
              </span>
            </div>
          </div>
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
            } catch (err) {
              console.error("Failed to refresh metrics:", err);
            }
          }}><RefreshCw size={12} /> Refresh Metrics</Btn>
        </div>
        {replicas.length === 0 ? (
          <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No replicas yet</p>
        ) : (
          <Table headers={["ID", "Container", "Server", "Port", "Status", "CPU", "Memory", "CPU (1h)", ""]}>
            {replicas.map((r) => {
              const series = metricsHistory
                .filter((s) => s.replica_id === r.id)
                .map((s) => s.cpu_percent);
              const srv = allServers.find((s) => s.id === r.server_id);
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
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="terminal.access">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
                          <Terminal size={12} /> Shell
                        </Btn>
                      </PermissionGate>
                      {allServers.length >= 2 && (
                        <PermissionGate permission="scaling.manage">
                          <div className="flex items-center gap-1">
                            <NeoSelect
                              value={migrateTarget[r.id] || ""}
                              onChange={(v) => setMigrateTarget((prev) => ({ ...prev, [r.id]: v }))}
                              options={allServers
                                .filter((s) => s.id !== r.server_id)
                                .map((s) => ({ value: String(s.id), label: s.name.replace(/^ocd-/, "") }))}
                              placeholder="Move to..."
                              compact
                            />
                            <Btn
                              size="xs"
                              variant="ghost"
                              loading={migratingId === r.id}
                              disabled={!migrateTarget[r.id] || migratingId !== null}
                              onClick={() => handleMigrate(r.id)}
                              title="Migrate replica to another server"
                            >
                              <ArrowRightLeft size={11} />
                            </Btn>
                          </div>
                        </PermissionGate>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        {migratingId !== null && migrateProgress && (
          <div className="mt-2 flex items-center gap-2 px-3 py-1.5 border-2 border-fg bg-alt">
            <Spinner />
            <span className="font-mono text-[10px] text-fg uppercase tracking-wider truncate">{migrateProgress}</span>
          </div>
        )}
      </Card>

    </div>
  );
}
