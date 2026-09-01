import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { get } from "../../api/client.ts";
import { runCliAction } from "../../api/cli-actions.ts";
import { Card, Btn, StatusBadge, showToast, Table, CopyButton, portalAnchorRect } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { RefreshCw, ExternalLink, Server as ServerIcon, Terminal, ArrowRightLeft } from "lucide-react";
import { Sparkline, InfoTip, CpuUsage, MemUsage } from "./shared.tsx";
import { type ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, MetricSample, ServerData } from "../../types.ts";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";

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
  const internalUrl = app.internal_protocol === "tcp"
    ? `tcp://${app.name}.ocd.internal:${app.container_port}`
    : `http://${app.name}.ocd.internal`;
  const [migratingId, setMigratingId] = useState<number | null>(null);
  const [availability, setAvailability] = useState<{ uptimePct: number | null; mttrSeconds: number | null; sampleCount: number; current: { running: number; desired: number; distinctHosts: number; distinctLocations: number; meetsTarget: boolean } } | null>(null);
  const [storage, setStorage] = useState<{ current: { image_size_bytes?: number } | null; rollback: { image_size_bytes?: number } | null; reclaimable_image_bytes_upper_bound: number; caveat: string } | null>(null);

  useEffect(() => {
    Promise.all([
      get(`/api/apps/${appId}/availability?window=86400`).catch(() => null),
      get(`/api/apps/${appId}/storage`).catch(() => null),
    ]).then(([nextAvailability, nextStorage]) => {
      setAvailability(nextAvailability);
      setStorage(nextStorage);
    });
  }, [appId]);

  const bytes = (value?: number | null) => typeof value === "number" && value > 0
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : "—";

  const handleMigrate = async (replicaId: number, targetId: string) => {
    if (!targetId) { showToast("Select a target server", "error"); return; }
    setMigratingId(replicaId);
    try {
      await runCliAction("scale.migrate", {
        app: String(appId),
        replica: String(replicaId),
        target: targetId,
      });
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
            <div className="flex justify-between gap-4">
              <span className="text-muted">Immutable Image</span>
              <span className="text-fg font-bold truncate" title={app.image_ref}>
                {app.image_ref || "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Configuration</span>
              <span className="text-fg">OCD revision {app.config_revision ?? 1}</span>
            </div>
            {app.last_manifest_path && (
              <div className="flex justify-between gap-4">
                <span className="text-muted">Last Manifest</span>
                <span
                  className={(app.last_manifest_config_revision ?? 0) === (app.config_revision ?? 1) ? "text-fg" : "text-accent-amber font-bold"}
                  title={app.last_manifest_hash ?? undefined}
                >
                  {app.last_manifest_path}
                  {(app.last_manifest_config_revision ?? 0) !== (app.config_revision ?? 1) ? " · differs" : ""}
                </span>
              </div>
            )}
            <div className="flex justify-between"><span className="text-muted">Container Port</span><span className="text-fg">{app.container_port}</span></div>
            <div className="flex justify-between gap-4">
              <span className="text-muted">Readiness</span>
              <span className="text-fg text-right" title={app.health_check_command || app.health_check_file}>
                {app.health_check_mode || (app.health_check ? "http" : "container")}
                {app.health_check_file ? ` · ${app.health_check_file} ≤ ${app.health_check_max_age_seconds}s` : ""}
              </span>
            </div>
            {replicas[0]?.host_port != null && (
              <div className="flex justify-between"><span className="text-muted">Host Port</span><span className="text-fg">{replicas[0].host_port}</span></div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-muted">Volume intent</span>
              <span className="text-fg text-right">
                {(app.desired_volume_size ?? 0) < 0
                  ? "legacy · explicit manifest required"
                  : (app.desired_volume_size ?? 0) > 0
                  ? `${app.desired_volume_id ? `adopt ${app.desired_volume_id}` : "managed"} · ${app.desired_volume_size} GB → ${app.desired_volume_path || "/data"}`
                  : "none"}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted">Volume actual</span>
              <span className={app.volume_id ? "text-fg text-right" : "text-fg-dim"}>
                {app.volume_id ? `${app.volume_id} · ${app.volume_mount}` : "none"}
              </span>
            </div>
            {app.auth_enabled && <div className="flex justify-between"><span className="text-muted">Auth</span><span className="text-accent-amber font-bold">Password protected</span></div>}
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
              <div className="flex justify-between items-center"><span className="text-muted">Public Domain</span><span className="flex items-center gap-1"><span className="text-fg-dim font-bold">Disabled</span><span className="font-mono text-[8px] font-bold border border-fg px-1 uppercase">Private</span></span></div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-muted flex items-center gap-1">Internal URL <InfoTip text="Reachable from other apps on the private network. Set this in env vars when one app needs to call another." /></span>
              <span className="flex items-center gap-1">
                <span className="text-fg font-bold">{internalUrl}</span>
                <CopyButton text={internalUrl} />
              </span>
            </div>
          </div>
          {app.dns_instruction && <DnsInstructionView value={app.dns_instruction} />}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Availability · trailing 24h</h3>
          {availability ? <div className="space-y-2 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-muted">Uptime</span><span className="font-bold">{availability.uptimePct == null ? "—" : `${availability.uptimePct.toFixed(3)}%`}</span></div>
            <div className="flex justify-between"><span className="text-muted">Mean recovery</span><span>{availability.mttrSeconds == null ? "—" : `${Math.round(availability.mttrSeconds)}s`}</span></div>
            <div className="flex justify-between"><span className="text-muted">Placement now</span><span className={availability.current.meetsTarget ? "text-fg" : "text-accent-red"}>{availability.current.running}/{availability.current.desired} replicas · {availability.current.distinctHosts} hosts · {availability.current.distinctLocations} locations</span></div>
            <div className="flex justify-between"><span className="text-muted">Samples</span><span>{availability.sampleCount}</span></div>
          </div> : <p className="font-mono text-[10px] text-muted">Availability data unavailable</p>}
        </Card>
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Image storage</h3>
          {storage ? <div className="space-y-2 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-muted">Current artifact</span><span>{bytes(storage.current?.image_size_bytes)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Rollback artifact</span><span>{bytes(storage.rollback?.image_size_bytes)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Reclaimable upper bound</span><span>{bytes(storage.reclaimable_image_bytes_upper_bound)}</span></div>
            <p className="pt-1 text-[9px] text-muted normal-case">{storage.caveat}</p>
          </div> : <p className="font-mono text-[10px] text-muted">Storage inventory unavailable</p>}
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
                  <td className="py-2 px-3 text-fg-dim"><CpuUsage cpuPercent={r.cpu_percent} limitCores={r.cpu_limit_cores} status={r.status} /></td>
                  <td className="py-2 px-3 text-fg-dim"><MemUsage memoryPercent={r.memory_percent} usedMb={r.memory_used_mb} limitMb={r.memory_limit_mb} status={r.status} /></td>
                  <td className="py-2 px-3"><Sparkline values={series} /></td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="terminal.container" appId={appId} environmentId={app.environment_id}>
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
                          <Terminal size={12} /> Shell
                        </Btn>
                      </PermissionGate>
                      {allServers.length >= 2 && (
                        <PermissionGate permission="scaling.migrate" appId={appId} environmentId={app.environment_id}>
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
