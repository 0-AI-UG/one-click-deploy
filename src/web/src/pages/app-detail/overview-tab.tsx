import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { get, post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, showToast, Table, CopyButton, portalAnchorRect } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { RefreshCw, ExternalLink, Server as ServerIcon, Terminal, ArrowRightLeft } from "lucide-react";
import { Sparkline, InfoTip } from "./shared.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, MetricSample, ServerData } from "../../types.ts";

interface OverviewTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  metricsHistory: MetricSample[];
  allServers: ServerData[];
  setReplicas: (r: ReplicaData[]) => void;
  ops: ResourceOpsResult;
}

export function OverviewTab({ app, appId, replicas, metricsHistory, allServers, setReplicas, ops }: OverviewTabProps) {
  const internalUrl = `http://${app.name}.ocd.internal:8080`;
  const [migratingId, setMigratingId] = useState<number | null>(null);

  const handleMigrate = async (replicaId: number, targetId: string) => {
    if (!targetId) { showToast("Select a target server", "error"); return; }
    setMigratingId(replicaId);
    try {
      const res = await post(`/api/apps/${appId}/replicas/${replicaId}/migrate`, {
        target_server_id: parseInt(targetId, 10),
      }) as { op_id: number };

      ops.track(res.op_id);
      const terminal = await trackOperationInToast(res.op_id, "Migrating replica");
      if (terminal && terminal !== "done" && terminal !== "cancelled") {
        throw new Error("Migration failed");
      }
      setReplicas(await get(`/api/apps/${appId}/metrics`));
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setMigratingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="flex justify-between"><span className="text-muted">Git Repo</span><span className="text-fg font-bold">{app.git_repo}</span></div>
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
            <div className="flex justify-between items-center">
              <span className="text-muted flex items-center gap-1">Internal URL <InfoTip text="Reachable from other apps on the private network. Set this in env vars when one app needs to call another." /></span>
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
                          <MoveMenu
                            targets={allServers.filter((s) => s.id !== r.server_id)}
                            loading={
                              migratingId === r.id ||
                              ops.active.some(
                                (o) => o.kind === "migrate" && (o.input as { replicaId?: number })?.replicaId === r.id,
                              )
                            }
                            disabled={ops.isBusy}
                            onPick={(targetId) => handleMigrate(r.id, targetId)}
                          />
                        </PermissionGate>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

    </div>
  );
}

function MoveMenu({ targets, loading, disabled, onPick }: {
  targets: ServerData[];
  loading: boolean;
  disabled: boolean;
  onPick: (targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const r = portalAnchorRect(triggerRef.current);
      setPos({ top: r.bottom + 4, left: r.right });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={triggerRef} className="inline-block">
      <Btn
        size="xs"
        variant="ghost"
        loading={loading}
        disabled={disabled}
        title="Migrate replica to another server"
        onClick={() => setOpen((o) => !o)}
      >
        <ArrowRightLeft size={11} /> Move
      </Btn>
      {open && !disabled && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
          className="z-50 bg-bg-raised border-2 border-fg shadow-neo min-w-40"
        >
          {targets.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[10px] text-fg-dim uppercase tracking-wider">
              No other servers
            </div>
          ) : (
            targets.map((s) => (
              <button
                key={s.id}
                onClick={() => { setOpen(false); onPick(String(s.id)); }}
                className="block w-full text-left px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg hover:bg-alt border-b border-fg/20 last:border-b-0"
              >
                {s.name.replace(/^ocd-/, "")}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
