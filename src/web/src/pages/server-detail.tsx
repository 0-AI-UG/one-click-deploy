import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, Spinner, EmptyState, Table } from "../components/ui.tsx";
import { Server, ArrowLeft, RefreshCw, Terminal, Box, Database, FileWarning, Network } from "lucide-react";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Sparkline } from "./app-detail/shared.tsx";
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
  created_at: string;
};

type ServerServiceInstance = {
  id: number;
  role: string;
  container_name: string;
  host_port: number;
  status: string;
  cpu_percent: number;
  memory_percent: number;
};

type ServerService = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
  instances: ServerServiceInstance[];
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
  private_ipv4: string;
  type: string;
  location: string;
  status: string;
  created_at: string;
  monthly_eur: number | null;
  currency: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  replicas: ServerReplica[];
  services: ServerService[];
  host: HostProbe;
};

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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

// Best-effort label for common listening ports — purely cosmetic.
function portLabel(port: number, process: string): string {
  const proc = process.toLowerCase();
  if (proc.includes("caddy")) return "Reverse proxy";
  if (proc.includes("docker")) return "Docker";
  if (proc.includes("sshd") || proc === "ssh") return "SSH";
  if (proc.includes("systemd-resolve")) return "DNS resolver";
  if (port === 22) return "SSH";
  if (port === 80) return "HTTP";
  if (port === 443) return "HTTPS";
  if (port === 2019) return "Reverse proxy admin";
  if (port === 53) return "DNS";
  if (port === 5432) return "PostgreSQL";
  if (port === 3306) return "MySQL";
  if (port === 6379) return "Redis";
  if (port === 27017) return "MongoDB";
  return "";
}

function portCategory(port: number, address: string, process: string): "public" | "private" | "local" {
  if (address === "127.0.0.1" || address === "::1") return "local";
  if (address.startsWith("10.") || address.startsWith("172.") || address.startsWith("192.168.")) return "private";
  // Caddy on 80/443 is intentionally public.
  if (port === 80 || port === 443 || port === 22) return "public";
  // Wildcard binds are public unless behind a firewall, but we still show as public/exposed.
  if (address === "0.0.0.0" || address === "*" || address === "::") return "public";
  return "public";
}

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

export function ServerDetailPage({ serverId }: { serverId: number }) {
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [d, h] = await Promise.all([
        get(`/api/resources/servers/${serverId}`),
        get("/api/resources/metrics/history?since=3600"),
      ]);
      setDetail(d);
      setHistory(h);
    } catch (err: any) {
      setDetailErr(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [serverId]);

  if (detailErr) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>
          <ArrowLeft size={11} /> Back to Resources
        </Btn>
        <Card className="p-6 mt-4">
          <EmptyState message={detailErr} icon={FileWarning} />
        </Card>
      </div>
    );
  }
  if (loading || !detail) return <div className="flex justify-center py-20"><Spinner /></div>;

  const cpuSeries = history.filter((m) => m.server_id === serverId).map((m) => m.cpu_percent);
  const memSeries = history.filter((m) => m.server_id === serverId).map((m) => m.memory_percent);
  const replicaCpuTotal = detail.replicas.reduce((acc, r) => acc + (r.cpu_percent || 0), 0);
  const replicaMemTotal = detail.replicas.reduce((acc, r) => acc + (r.memory_percent || 0), 0);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Btn variant="ghost" size="xs" onClick={() => { window.location.hash = "#/resources"; }}>
          <ArrowLeft size={11} /> Resources
        </Btn>
        <Server size={16} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">{detail.name}</h1>
        <span className={`font-mono text-[10px] uppercase ${statusClass(detail.status)}`}>· {detail.status}</span>
        <div className="ml-auto flex items-center gap-1">
          <PermissionGate permission="terminal.access">
            <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/server/${detail.id}`; }}>
              <Terminal size={11} /> Shell
            </Btn>
          </PermissionGate>
          <Btn size="xs" variant="ghost" onClick={() => { setLoading(true); load(); }}>
            <RefreshCw size={11} /> Refresh
          </Btn>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Info label="Type" value={detail.type.toUpperCase()} />
          <Info label="Location" value={detail.location} />
          <Info label="Public IPv4" value={detail.ipv4 || "—"} />
          <Info label="Private IPv4" value={detail.private_ipv4 || "—"} />
          <Info label="€/mo" value={detail.monthly_eur != null ? `€${detail.monthly_eur.toFixed(2)}` : "—"} />
          <Info label="Provider" value={detail.provider} />
          <Info label="Provider ID" value={detail.provider_id} />
          <Info label="Created" value={new Date(detail.created_at).toLocaleDateString()} />
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">CPU (1h)</h3>
          <div className="flex items-center justify-between">
            <span className="font-mono text-lg font-bold text-fg">
              {detail.cpu_percent != null ? `${detail.cpu_percent}%` : "—"}
            </span>
            <Sparkline values={cpuSeries} />
          </div>
          <div className="font-mono text-[9px] text-muted mt-1 space-y-0.5">
            <div>host load (1m): {detail.host.load1 != null ? detail.host.load1.toFixed(2) : "—"}{detail.host.cpu_cores ? ` / ${detail.host.cpu_cores} core${detail.host.cpu_cores > 1 ? "s" : ""}` : ""}</div>
            <div>5m {detail.host.load5?.toFixed(2) ?? "—"} · 15m {detail.host.load15?.toFixed(2) ?? "—"}</div>
            <div>replicas total: {replicaCpuTotal.toFixed(0)}%</div>
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Memory (1h)</h3>
          <div className="flex items-center justify-between">
            <span className="font-mono text-lg font-bold text-fg">
              {detail.memory_percent != null ? `${detail.memory_percent}%` : "—"}
            </span>
            <Sparkline values={memSeries} color="#f59e0b" />
          </div>
          {detail.host.mem_total_mb != null ? (
            <div className="mt-2">
              <Bar
                value={detail.host.mem_used_mb != null ? (detail.host.mem_used_mb / detail.host.mem_total_mb) * 100 : 0}
                color="#f59e0b"
              />
              <div className="font-mono text-[9px] text-muted mt-1 space-y-0.5">
                <div>used {fmtMb(detail.host.mem_used_mb)} · avail {fmtMb(detail.host.mem_available_mb)} · total {fmtMb(detail.host.mem_total_mb)}</div>
                <div>buffers/cache {fmtMb(detail.host.mem_buffers_cache_mb)}{detail.host.swap_total_mb ? ` · swap ${fmtMb(detail.host.swap_used_mb)}/${fmtMb(detail.host.swap_total_mb)}` : ""}</div>
                <div>replicas total: {replicaMemTotal.toFixed(0)}%</div>
              </div>
            </div>
          ) : (
            <div className="font-mono text-[9px] text-muted mt-1">replicas total: {replicaMemTotal.toFixed(0)}%</div>
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
          {detail.host.uptime_seconds != null && (
            <div className="font-mono text-[9px] text-muted mt-2 space-y-0.5">
              <div>uptime {fmtUptime(detail.host.uptime_seconds)}</div>
              <div>processes {detail.host.processes ?? "—"}</div>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Network size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Listening Ports</h3>
          {detail.host.net && (
            <span className="ml-auto font-mono text-[9px] text-muted">
              {detail.host.net.iface}: ↓ {fmtBytes(detail.host.net.rx_bytes)} · ↑ {fmtBytes(detail.host.net.tx_bytes)}
            </span>
          )}
        </div>
        {detail.host.error ? (
          <EmptyState message={`Could not probe host: ${detail.host.error}`} icon={FileWarning} />
        ) : !detail.host.ports.length ? (
          <EmptyState message="No listening ports detected" />
        ) : (
          <PortGrid ports={detail.host.ports} />
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Box size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">
            Replicas ({detail.replicas.length})
          </h3>
        </div>
        {!detail.replicas.length ? (
          <EmptyState message="No app replicas on this server" />
        ) : (
          <Table headers={["App", "Container", "Port", "Status", "CPU", "Memory", ""]}>
            {detail.replicas.map((r) => (
              <tr key={r.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a
                    href={`#/apps/${r.app_id}`}
                    className="text-accent-blue font-bold hover:underline"
                  >
                    {r.app_name}
                  </a>
                </td>
                <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">{r.container_name}</td>
                <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">{r.host_port}</td>
                <td className={`py-2 px-3 font-mono text-[10px] uppercase ${statusClass(r.status)}`}>{r.status}</td>
                <td className="py-2 px-3"><Bar value={r.cpu_percent} color="#3b82f6" /></td>
                <td className="py-2 px-3"><Bar value={r.memory_percent} color="#f59e0b" /></td>
                <td className="py-2 px-3">
                  <PermissionGate permission="terminal.access">
                    <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
                      <Terminal size={11} />
                    </Btn>
                  </PermissionGate>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {detail.services.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Database size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">
              Services ({detail.services.length})
            </h3>
          </div>
          <Table headers={["Name", "Type", "Version", "Role", "Container", "Status", "CPU", "Memory"]}>
            {detail.services.flatMap((s) =>
              s.instances.length
                ? s.instances.map((i) => (
                    <tr key={`${s.id}-${i.id}`} className="hover:bg-alt/50">
                      <td className="py-2 px-3 text-fg font-bold">{s.name}</td>
                      <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{s.service_type}</span></td>
                      <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">{s.version}</td>
                      <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">{i.role}</td>
                      <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">{i.container_name}</td>
                      <td className={`py-2 px-3 font-mono text-[10px] uppercase ${statusClass(i.status)}`}>{i.status}</td>
                      <td className="py-2 px-3"><Bar value={i.cpu_percent} color="#3b82f6" /></td>
                      <td className="py-2 px-3"><Bar value={i.memory_percent} color="#f59e0b" /></td>
                    </tr>
                  ))
                : []
            )}
          </Table>
        </Card>
      )}
    </div>
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

function PortGrid({ ports }: { ports: { proto: string; address: string; port: number; process: string }[] }) {
  const groups: Record<"public" | "private" | "local", typeof ports> = { public: [], private: [], local: [] };
  for (const p of ports) {
    groups[portCategory(p.port, p.address, p.process)].push(p);
  }
  const order: Array<{ key: "public" | "private" | "local"; label: string; tint: string }> = [
    { key: "public", label: "Public / exposed", tint: "border-accent-amber" },
    { key: "private", label: "Private network", tint: "border-accent-blue" },
    { key: "local", label: "Localhost only", tint: "border-fg/40" },
  ];

  return (
    <div className="space-y-3">
      {order.map((g) =>
        groups[g.key].length === 0 ? null : (
          <div key={g.key}>
            <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1.5">{g.label}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {groups[g.key].map((p, i) => {
                const label = portLabel(p.port, p.process);
                return (
                  <div key={i} className={`border-2 ${g.tint} bg-alt px-2 py-1.5 flex items-center gap-2`}>
                    <span className="font-mono text-sm font-bold text-fg">:{p.port}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[10px] text-fg truncate" title={`${p.address}:${p.port}`}>
                        {label || (p.process || "unknown")}
                      </div>
                      <div className="font-mono text-[9px] text-muted truncate">
                        {p.proto} · {p.address}{p.process && label ? ` · ${p.process}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}
    </div>
  );
}
