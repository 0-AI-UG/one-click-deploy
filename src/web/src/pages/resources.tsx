import { useState, useEffect, useRef } from "react";
import { get, del, post } from "../api/client.ts";
import { Card, Btn, Table, EmptyState, Spinner, showToast, confirm } from "../components/ui.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Sparkline } from "./app-detail/shared.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { HardDrive, Server, Database, Trash2, RefreshCw, Terminal, Plus } from "lucide-react";
import { orgPath } from "../stores/auth.ts";
import type { ResourcesData, ServerMetricSample } from "../types.ts";
import { errMsg } from "../lib/errors.ts";

export function ResourcesPage() {
  const [data, setData] = useState<ResourcesData | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Create server form state
  const [createType, setCreateType] = useState("");
  const [createLocation, setCreateLocation] = useState("");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState("");
  const { serverTypes } = useServerTypes();
  const aliveRef = useRef(true);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showCreate, setShowCreate] = useState(false);

  const ops = useActiveOperations(
    (op) => op.kind === "provision_server" || op.kind === "destroy_server",
    { rehydrateToasts: true },
  );

  const togglePopover = () => setShowCreate((v) => !v);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!showCreate) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target) && !target.closest("[data-neoselect-menu]")) {
        setShowCreate(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showCreate]);

  const handleCreateServer = async () => {
    if (!createType || !createLocation) {
      showToast("Select server type and location", "error");
      return;
    }
    setCreating(true);
    try {
      const res = await post("/api/resources/servers", {
        server_type: createType,
        location: createLocation,
        name: createName || undefined,
      }) as { op_id: number };
      trackOperationInToast(res.op_id, "Provisioning server");
      ops.track(res.op_id);
      setShowCreate(false);
      setCreateType("");
      setCreateLocation("");
      setCreateName("");
      load();
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally {
      setCreating(false);
      setCreateProgress("");
    }
  };

  const load = async () => {
    try {
      const [resources, history] = await Promise.all([
        get("/api/resources"),
        get("/api/resources/metrics/history?since=3600"),
      ]);
      setData(resources);
      setMetricsHistory(history);
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (type: string, id: string, name: string) => {
    if (!await confirm("Delete Resource", `Delete ${type.replace("_", " ")} "${name}"? This cannot be undone.`, true)) return;
    const key = `${type}-${id}`;
    setDeleting(key);
    try {
      const res = await del(`/api/resources/${type}/${id}`);
      if (res.ok) {
        if (type === "server" && res.op_id) {
          trackOperationInToast(res.op_id, `Destroying ${name}`);
          ops.track(res.op_id);
        } else {
          showToast(`${name} deleted`, "success");
        }
        load();
      } else {
        showToast(res.error || "Failed to delete", "error");
      }
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally {
      setDeleting(null);
    }
  };

  const fmtPrice = (eur: number | null | undefined) => {
    if (eur == null) return "—";
    return `€${eur.toFixed(2)}`;
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Resources</h1>
        </div>
        <Btn variant="ghost" onClick={() => { setLoading(true); load(); }}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {/* Cost estimate */}
      {data?.totals && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Estimated Monthly Cost</h3>
            <span className="font-mono text-[9px] text-muted uppercase tracking-wider">
              gross · {data.totals.currency || "EUR"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="border-2 border-fg p-3 bg-alt">
              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1">Servers</div>
              <div className="font-mono text-sm font-bold text-fg">{fmtPrice(data.totals.servers)}</div>
            </div>
            <div className="border-2 border-fg p-3 bg-alt">
              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1">Volumes</div>
              <div className="font-mono text-sm font-bold text-fg">{fmtPrice(data.totals.volumes)}</div>
            </div>
            <div className="border-2 border-fg p-3 bg-accent">
              <div className="font-mono text-[9px] text-fg uppercase tracking-wider mb-1 font-bold">Total / month</div>
              <div className="font-mono text-sm font-bold text-fg">{fmtPrice(data.totals.total)}</div>
            </div>
          </div>
          <p className="font-mono text-[9px] text-muted mt-3">
            Estimates based on Hetzner list prices. Excludes traffic overage and snapshots.
          </p>
        </Card>
      )}

      {/* Servers */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Server size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Servers ({data?.servers?.length || 0})</h3>
          <div className="ml-auto relative" ref={popoverRef}>
            <PermissionGate permission="resources.create">
              <Btn size="xs" onClick={creating ? undefined : togglePopover}>
                <Plus size={11} /> Create Server
              </Btn>
            </PermissionGate>
            {showCreate && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-bg-raised border-2 border-fg shadow-neo p-3 space-y-2 w-52">
                <NeoSelect
                  value={createType}
                  options={typeOptions(serverTypes)}
                  onChange={(v) => { setCreateType(v); setCreateLocation(""); }}
                  placeholder="Type..."
                  compact
                />
                <NeoSelect
                  value={createLocation}
                  options={locationOptions(serverTypes, createType)}
                  onChange={setCreateLocation}
                  placeholder="Location..."
                  compact
                />
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Name (optional)"
                  className="font-mono text-[10px] w-full"
                />
                <Btn size="xs" variant="primary" onClick={handleCreateServer} disabled={creating || ops.isBusyWith("provision_server") || !createType || !createLocation} className="w-full">
                  {ops.isBusyWith("provision_server") ? "Provisioning…" : (creating && createProgress ? createProgress : "Create")}
                </Btn>
              </div>
            )}
          </div>
        </div>
        {!data?.servers?.length ? <EmptyState message="No servers" /> : (
          <Table headers={["Name", "IP", "Type", "CPU", "RAM", "CPU (1h)", "RAM (1h)", "Location", "Replicas", "€/mo", ""]}>
            {data.servers.map((s) => {
              const cpuSeries = metricsHistory
                .filter((m) => m.server_id === s.id)
                .map((m) => m.cpu_percent);
              const memSeries = metricsHistory
                .filter((m) => m.server_id === s.id)
                .map((m) => m.memory_percent);
              return (
                <tr key={s.id} className="hover:bg-alt/50">
                  <td className="py-2 px-3 text-fg font-bold">{s.name}</td>
                  <td className="py-2 px-3 text-fg-dim">{s.ipv4}</td>
                  <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{s.type}</span></td>
                  <td className="py-2 px-3 font-mono text-xs">{s.cpu_percent != null ? `${s.cpu_percent}%` : "—"}</td>
                  <td className="py-2 px-3 font-mono text-xs">{s.memory_percent != null ? `${s.memory_percent}%` : "—"}</td>
                  <td className="py-2 px-3"><Sparkline values={cpuSeries} /></td>
                  <td className="py-2 px-3"><Sparkline values={memSeries} color="#f59e0b" /></td>
                  <td className="py-2 px-3 text-fg-dim">{s.location}</td>
                  <td className="py-2 px-3 text-fg-dim">{s.replica_count}</td>
                  <td className="py-2 px-3 text-fg font-bold">{fmtPrice(s.monthly_eur)}</td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-1">
                      <PermissionGate permission="terminal.access">
                        <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = orgPath(`/terminal/server/${s.id}`); }}>
                          <Terminal size={11} /> Shell
                        </Btn>
                      </PermissionGate>
                      <PermissionGate permission="resources.delete">
                        <Btn
                          size="xs"
                          variant="danger"
                          disabled={s.replica_count > 0}
                          title={s.replica_count > 0 ? "In use by replicas" : undefined}
                          loading={deleting === `server-${s.provider_id}` || !!ops.byResourceKey(`server:${s.id}`)}
                          onClick={() => handleDelete("server", s.provider_id, s.name)}
                        >
                          <Trash2 size={11} />
                        </Btn>
                      </PermissionGate>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* Volumes */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Volumes ({data?.volumes?.length || 0})</h3>
        </div>
        {!data?.volumes?.length ? <EmptyState message="No volumes" /> : (
          <Table headers={["Name", "Size", "Location", "Server", "App", "€/mo", ""]}>
            {data.volumes.map((v) => (
              <tr key={v.id} className="hover:bg-alt/50">
                <td className="py-2 px-3 text-fg font-bold">{v.name}</td>
                <td className="py-2 px-3 text-fg-dim">{v.size} GB</td>
                <td className="py-2 px-3 text-fg-dim">{v.location}</td>
                <td className="py-2 px-3 text-fg-dim">{v.server_name || "—"}</td>
                <td className="py-2 px-3 text-accent-blue font-bold">{v.app_name || "—"}</td>
                <td className="py-2 px-3 text-fg font-bold">{fmtPrice(v.monthly_eur)}</td>
                <td className="py-2 px-3">
                  <PermissionGate permission="resources.delete">
                    <Btn size="xs" variant="danger" disabled={!!v.app_name} title={v.app_name ? `In use by ${v.app_name}` : undefined} loading={deleting === `volume-${v.id}`} onClick={() => handleDelete("volume", v.id, v.name)}>
                      <Trash2 size={11} />
                    </Btn>
                  </PermissionGate>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
