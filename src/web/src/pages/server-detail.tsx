import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { runCliAction } from "../api/cli-actions.ts";
import { Card, Btn, EmptyState, Table, StatusBadge, showToast, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { Server, ArrowLeft, RefreshCw, Terminal, FileWarning, Network, Layers, Check, X } from "lucide-react";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Sparkline, CpuUsage, MemUsage } from "./app-detail/shared.tsx";
import type { ServerMetricSample } from "../types.ts";

type ServerReplica = {
  id: number;
  app_id: number;
  app_name: string;
  container_name: string;
  host_port: number;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  cpu_limit_cores: number;
  memory_used_mb: number;
  memory_limit_mb: number;
  created_at: string;
};

type ReplicaMetricSample = {
  replica_id: number;
  cpu_percent: number;
  memory_percent: number;
  sampled_at: string;
};

type HostProbe = {
  uptime_seconds: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_cores: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  mem_free_mb: number | null;
  mem_available_mb: number | null;
  mem_buffers_cache_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  processes: number | null;
  ports: { proto: string; address: string; port: number; process: string }[];
  net: { iface: string; rx_bytes: number; tx_bytes: number } | null;
  error: string | null;
};

type ServerDetail = {
  id: number;
  name: string;
  provider_id: string;
  provider: string;
  ipv4: string;
  ipv6: string;
  routing_address: string;
  type: string;
  location: string;
  status: string;
  // Capacity pool governing FUTURE replica placement. May be absent from the
  // detail response until the backend includes it — treated as "general".
  pool?: "general" | "staging" | string;
  created_at: string;
  monthly_eur: number | null;
  currency: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  replicas: ServerReplica[];
  replica_metrics: ReplicaMetricSample[];
  host: HostProbe;
};

function statusClass(s: string): string {
  if (s === "running") return "text-accent-green";
  if (s === "stopped" || s === "failed") return "text-accent-red";
  return "text-fg-dim";
}

function Bar({ value, color }: { value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 border border-fg/30 bg-alt overflow-hidden">
        <div className="h-full" style={{ width: `${v}%`, background: color }} />
      </div>
      <span className="font-mono text-[10px] text-fg-dim w-9 text-right">{v.toFixed(0)}%</span>
    </div>
  );
}

function fmtUptime(s: number | null): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtMb(mb: number | null): string {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// Public-facing well-known ports get a colored dot. Everything else stays neutral.
function portDot(port: number, address: string): string {
  if (port === 80 || port === 443) return "bg-accent-green";
  if (port === 22) return "bg-accent-blue";
  if (address === "127.0.0.1" || address === "::1") return "bg-fg/30";
  if (address.startsWith("10.") || address.startsWith("172.") || address.startsWith("192.168.")) return "bg-accent-blue";
  return "bg-accent-amber";
}

// Fleet infrastructure ports show up as many near-identical listeners in a raw
// socket scan; collapse each known block into a single summary chip instead of
// flooding the view. Internal ingress is per-app VIPs: every app VIP shares the
// proxy's single :18790 listener (PROXY_LISTEN_PORT in src/proxy/config.ts) and
// wake calls hit the waker's :8896 (WAKER_HTTP_PORT in
// src/engine/scale/traefik-constants.ts). The public pool range mirrors
// src/shared/db/apps.ts (PUBLIC_*).
// tone "blue" = private-net only, "amber" = publicly exposed via the firewall.
const PORT_GROUPS = [
  { key: "proxy vip", lo: 18789, hi: 18790, tone: "blue", note: "per-app VIP ingress — L4 proxy listeners (18790 internal, 18789 public raw)" },
  { key: "waker", lo: 8896, hi: 8896, tone: "blue", note: "scale-to-zero wake endpoint" },
] as const;

function portGroupKey(port: number): string | null {
  for (const g of PORT_GROUPS) if (port >= g.lo && port <= g.hi) return g.key;
  return null;
}

// A pool name is a lowercase slug, ≤32 chars — mirrors the backend validation on
// PATCH /api/servers/:id/pool. Sentinel select value that reveals the "new pool"
// text input instead of switching pools.
const POOL_SLUG = /^[a-z][a-z0-9-]*$/;
const NEW_POOL = "__new-pool__";

export function ServerDetailPage({ serverId }: { serverId: number }) {
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState<string>("general");
  const [poolSaving, setPoolSaving] = useState(false);
  // Known pools from GET /api/pools (always includes general + staging); falls
  // back to those two until the fetch resolves. Plus the inline "new pool" form.
  const [poolOptions, setPoolOptions] = useState<string[]>(["general", "staging"]);
  const [newPoolMode, setNewPoolMode] = useState(false);
  const [newPoolValue, setNewPoolValue] = useState("");
  const [newPoolErr, setNewPoolErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const [d, h] = await Promise.all([
        get(`/api/resources/servers/${serverId}`),
        get("/api/resources/metrics/history?since=3600"),
      ]);
      setDetail(d);
      setPool(d.pool ?? "general");
      setHistory(h);
    } catch (err: any) {
      setDetailErr(err.message);
    } finally {
      setLoading(false);
    }
    // Non-fatal: keep the two hardcoded fallbacks if the pool list can't load.
    try {
      const res = await get("/api/pools");
      if (Array.isArray(res?.pools) && res.pools.length) setPoolOptions(res.pools);
    } catch {
      /* keep fallback */
    }
  };

  const changePool = async (next: string) => {
    const prev = pool;
    if (next === prev) return;
    setPool(next);
    setPoolSaving(true);
    try {
      await runCliAction("servers.pool", { server: String(serverId), pool: next });
      setDetail((d) => (d ? { ...d, pool: next } : d));
      showToast(`Server moved to the "${next}" pool`, "success");
    } catch (err: any) {
      setPool(prev);
      showToast(err?.message || "Failed to change pool", "error");
    } finally {
      setPoolSaving(false);
    }
  };

  // Select handler: sentinel reveals the inline "new pool" input; anything else
  // switches pools directly.
  const onPoolSelect = (v: string) => {
    if (v === NEW_POOL) {
      setNewPoolValue("");
      setNewPoolErr(null);
      setNewPoolMode(true);
      return;
    }
    changePool(v);
  };

  const confirmNewPool = () => {
    const slug = newPoolValue.trim().toLowerCase();
    if (!POOL_SLUG.test(slug) || slug.length > 32) {
      setNewPoolErr("lowercase slug, ≤32 chars");
      return;
    }
    setNewPoolMode(false);
    changePool(slug);
  };

  useEffect(() => { load(); }, [serverId]);

  if (detailErr) {
    return (
      <PageState kind="error" title="Server unavailable" description={detailErr} action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>Back to resources</Btn>} />
    );
  }
  if (loading || !detail) return <PageState title="Loading server" />;

  const cpuSeries = history.filter((m) => m.server_id === serverId).map((m) => m.cpu_percent);
  const memSeries = history.filter((m) => m.server_id === serverId).map((m) => m.memory_percent);

  const singlePorts = detail.host.ports.filter((p) => portGroupKey(p.port) == null);
  const portBlocks = PORT_GROUPS
    .map((g) => ({ ...g, count: detail.host.ports.filter((p) => p.port >= g.lo && p.port <= g.hi).length }))
    .filter((g) => g.count > 0);

  return (
    <PageShell>
      <PageHeader backHref="#/resources" backLabel="Back to resources" eyebrow="Server" title={detail.name} meta={<StatusBadge status={detail.status} />} actions={<div className="flex items-center gap-1">
          <PermissionGate
            permission="servers.delete"
            fallback={
              <span
                title="New replicas schedule onto servers in this pool. 'staging' isolates staging-target apps from production."
                className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim border-2 border-fg/40 bg-alt px-1.5 py-[3px]"
              >
                <Layers size={10} /> {pool}
              </span>
            }
          >
            {newPoolMode ? (
              <div className="relative flex items-center gap-1">
                <input
                  value={newPoolValue}
                  onChange={(e) => { setNewPoolValue(e.target.value); setNewPoolErr(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmNewPool();
                    if (e.key === "Escape") setNewPoolMode(false);
                  }}
                  placeholder="pool-name"
                  autoFocus
                  className="w-24 bg-bg-raised border-2 border-fg px-1.5 py-[3px] font-mono text-[9px] text-fg placeholder:text-muted focus:outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={confirmNewPool}
                  title="Move to this pool"
                  className="flex items-center border-2 border-fg bg-accent-green text-black px-1 py-[3px] cursor-pointer"
                >
                  <Check size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => setNewPoolMode(false)}
                  title="Cancel"
                  className="flex items-center border-2 border-fg bg-alt text-fg-dim hover:text-fg px-1 py-[3px] cursor-pointer"
                >
                  <X size={11} />
                </button>
                {newPoolErr && (
                  <span className="absolute top-full left-0 mt-0.5 font-mono text-[8px] font-bold uppercase text-accent-red whitespace-nowrap">
                    {newPoolErr}
                  </span>
                )}
              </div>
            ) : (
              <div
                className="w-28"
                title="New replicas schedule onto servers in this pool. 'staging' isolates staging-target apps from production."
              >
                <NeoSelect
                  compact
                  value={pool}
                  disabled={poolSaving}
                  onChange={onPoolSelect}
                  options={[
                    ...Array.from(new Set([...poolOptions, pool])).sort().map((p) => ({ value: p, label: p })),
                    { value: NEW_POOL, label: "+ New pool…" },
                  ]}
                />
              </div>
            )}
          </PermissionGate>
          <PermissionGate permission="terminal.access">
            <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/server/${detail.id}`; }}>
              <Terminal size={11} /> Shell
            </Btn>
          </PermissionGate>
          <Btn size="xs" variant="ghost" onClick={() => { setLoading(true); load(); }}>
            <RefreshCw size={11} /> Refresh
          </Btn>
        </div>} />

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Info label="Type" value={detail.type.toUpperCase()} />
          <Info label="Location" value={detail.location} />
          <Info label="Public IPv4" value={detail.ipv4 || "—"} />
          <Info label="Private IPv4" value={detail.routing_address || "—"} />
          <Info label="€/mo" value={detail.monthly_eur != null ? `€${detail.monthly_eur.toFixed(2)}` : "—"} />
          <Info label="Uptime" value={fmtUptime(detail.host.uptime_seconds)} />
          <Info label="Processes" value={detail.host.processes != null ? String(detail.host.processes) : "—"} />
          <Info label="Created" value={new Date(detail.created_at).toLocaleDateString()} />
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">CPU (1h)</h3>
          <div className="flex items-center justify-between">
            <span className="font-mono text-lg font-bold text-fg">
              {detail.cpu_percent != null && detail.host.cpu_cores
                ? `${((detail.cpu_percent / 100) * detail.host.cpu_cores).toFixed(1)} / ${detail.host.cpu_cores} vCPU`
                : detail.cpu_percent != null ? `${detail.cpu_percent}%` : "—"}
            </span>
            <Sparkline values={cpuSeries} />
          </div>
          {detail.host.load1 != null && (
            <div className="font-mono text-[9px] text-muted mt-1">
              load {detail.host.load1.toFixed(2)} · {detail.host.load5?.toFixed(2)} · {detail.host.load15?.toFixed(2)}
              {detail.host.cpu_cores ? ` / ${detail.host.cpu_cores}` : ""}
            </div>
          )}
        </Card>
        <Card className="p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Memory (1h)</h3>
          <div className="flex items-center justify-between">
            <span className="font-mono text-lg font-bold text-fg">
              {detail.host.mem_total_mb != null
                ? `${fmtMb(detail.host.mem_used_mb)} / ${fmtMb(detail.host.mem_total_mb)}`
                : detail.memory_percent != null ? `${detail.memory_percent}%` : "—"}
            </span>
            <Sparkline values={memSeries} color="#f59e0b" />
          </div>
          {detail.host.mem_total_mb != null && (
            <div className="font-mono text-[9px] text-muted mt-1">
              {detail.memory_percent != null ? `${detail.memory_percent}% used` : ""}
              {detail.host.swap_total_mb ? ` · swap ${fmtMb(detail.host.swap_used_mb)}` : ""}
            </div>
          )}
        </Card>
        <Card className="p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Disk</h3>
          {detail.disk_total_gb != null && detail.disk_free_gb != null ? (
            <>
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-lg font-bold text-fg">{detail.disk_free_gb}</span>
                <span className="font-mono text-[10px] text-muted">/ {detail.disk_total_gb} GB free</span>
              </div>
              <Bar
                value={((detail.disk_total_gb - detail.disk_free_gb) / detail.disk_total_gb) * 100}
                color={detail.disk_free_gb < 2 ? "#ef4444" : detail.disk_free_gb < 5 ? "#f59e0b" : "#3b82f6"}
              />
            </>
          ) : (
            <span className="font-mono text-[10px] text-muted">no data</span>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Network size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Ports</h3>
          {detail.host.net && (
            <span className="ml-auto font-mono text-[9px] text-muted">
              ↓ {(detail.host.net.rx_bytes / 1024 / 1024 / 1024).toFixed(1)}G · ↑ {(detail.host.net.tx_bytes / 1024 / 1024 / 1024).toFixed(1)}G
            </span>
          )}
        </div>
        {detail.host.error ? (
          <EmptyState message="Probe failed" icon={FileWarning} />
        ) : !detail.host.ports.length ? (
          <EmptyState message="No listening ports" />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {singlePorts.map((p, i) => (
              <span
                key={i}
                title={`${p.address}:${p.port}${p.process ? ` (${p.process})` : ""}`}
                className="inline-flex items-center gap-1.5 border border-fg/40 bg-alt px-2 py-0.5 font-mono text-[10px] font-bold text-fg"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${portDot(p.port, p.address)}`} />
                {p.port}
              </span>
            ))}
            {portBlocks.map((g) => (
              <span
                key={g.key}
                title={`${g.count} listening in ${g.lo}-${g.hi}: ${g.note}, held for the fleet's lifetime`}
                className="inline-flex items-center gap-1.5 border border-accent-blue/40 bg-alt px-2 py-0.5 font-mono text-[10px] font-bold text-fg"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-accent-blue" />
                {g.key} {g.lo}-{g.hi} · {g.count}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">
          Replicas ({detail.replicas.length})
        </h3>
        {!detail.replicas.length ? (
          <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No replicas on this server</p>
        ) : (
          <Table headers={["ID", "Container", "App", "Port", "Status", "CPU", "Memory", "CPU (1h)", ""]}>
            {detail.replicas.map((r) => {
              const series = detail.replica_metrics
                .filter((s) => s.replica_id === r.id)
                .map((s) => s.cpu_percent);
              return (
                <tr key={r.id}>
                  <td className="py-2 px-3 text-fg font-bold">#{r.id}</td>
                  <td className="py-2 px-3 text-fg-dim">{r.container_name}</td>
                  <td className="py-2 px-3 text-[9px]">
                    <a href={`#/apps/${r.app_id}`} className="text-accent-blue font-bold hover:underline">
                      {r.app_name}
                    </a>
                  </td>
                  <td className="py-2 px-3 text-fg-dim">{r.host_port}</td>
                  <td className="py-2 px-3"><StatusBadge status={r.status} /></td>
                  <td className="py-2 px-3 text-fg-dim"><CpuUsage cpuPercent={r.cpu_percent} limitCores={r.cpu_limit_cores} status={r.status} /></td>
                  <td className="py-2 px-3 text-fg-dim"><MemUsage memoryPercent={r.memory_percent} usedMb={r.memory_used_mb} limitMb={r.memory_limit_mb} status={r.status} /></td>
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

    </PageShell>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-fg p-2 bg-alt">
      <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="font-mono text-xs font-bold text-fg truncate" title={value}>{value}</div>
    </div>
  );
}
