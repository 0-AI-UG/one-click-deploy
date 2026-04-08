import { useState, useEffect } from "react";
import { get, del } from "../api/client.ts";
import { Card, Btn, Table, EmptyState, Spinner, showToast, confirm } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { HardDrive, Server, Network, Database, Trash2, RefreshCw, Terminal } from "lucide-react";

export function ResourcesPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await get("/api/resources"));
    } catch (err: any) {
      showToast(err.message, "error");
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
        showToast(`${name} deleted`, "success");
        load();
      } else {
        showToast(res.error || "Failed to delete", "error");
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Resources</h1>
        </div>
        <Btn variant="ghost" onClick={() => { setLoading(true); load(); }}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {/* Servers */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Server size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Servers ({data?.servers?.length || 0})</h3>
        </div>
        {!data?.servers?.length ? <EmptyState message="No servers" /> : (
          <Table headers={["Name", "IP", "Type", "Location", "Apps", "Replicas", ""]}>
            {data.servers.map((s: any) => (
              <tr key={s.id} className="hover:bg-alt/50">
                <td className="py-2 px-3 text-fg font-bold">{s.name}</td>
                <td className="py-2 px-3 text-fg-dim">{s.ipv4}</td>
                <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{s.type}</span></td>
                <td className="py-2 px-3 text-fg-dim">{s.location}</td>
                <td className="py-2 px-3 text-fg-dim">{s.app_count}</td>
                <td className="py-2 px-3 text-fg-dim">{s.replica_count}</td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-1">
                    <PermissionGate permission="terminal.access">
                      <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/server/${s.id}`; }}>
                        <Terminal size={11} /> Shell
                      </Btn>
                    </PermissionGate>
                    <PermissionGate permission="resources.delete">
                      <Btn size="xs" variant="danger" disabled={s.app_count > 0 || s.replica_count > 0} title={s.app_count > 0 || s.replica_count > 0 ? "In use by apps or replicas" : undefined} loading={deleting === `server-${s.hetzner_id}`} onClick={() => handleDelete("server", s.hetzner_id, s.name)}>
                        <Trash2 size={11} />
                      </Btn>
                    </PermissionGate>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Load Balancers */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Network size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Load Balancers ({data?.load_balancers?.length || 0})</h3>
        </div>
        {!data?.load_balancers?.length ? <EmptyState message="No load balancers" /> : (
          <Table headers={["Name", "IP", "Type", "Location", "App", "Targets", ""]}>
            {data.load_balancers.map((lb: any) => (
              <tr key={lb.id} className="hover:bg-alt/50">
                <td className="py-2 px-3 text-fg font-bold">{lb.name}</td>
                <td className="py-2 px-3 text-fg-dim">{lb.ipv4}</td>
                <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{lb.type}</span></td>
                <td className="py-2 px-3 text-fg-dim">{lb.location}</td>
                <td className="py-2 px-3 text-accent-blue font-bold">{lb.app_name || "—"}</td>
                <td className="py-2 px-3 text-fg-dim">{lb.targets}</td>
                <td className="py-2 px-3">
                  <PermissionGate permission="resources.delete">
                    <Btn size="xs" variant="danger" disabled={!!lb.app_name} title={lb.app_name ? `In use by ${lb.app_name}` : undefined} loading={deleting === `load_balancer-${lb.id}`} onClick={() => handleDelete("load_balancer", lb.id, lb.name)}>
                      <Trash2 size={11} />
                    </Btn>
                  </PermissionGate>
                </td>
              </tr>
            ))}
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
          <Table headers={["Name", "Size", "Location", "Server", "App", ""]}>
            {data.volumes.map((v: any) => (
              <tr key={v.id} className="hover:bg-alt/50">
                <td className="py-2 px-3 text-fg font-bold">{v.name}</td>
                <td className="py-2 px-3 text-fg-dim">{v.size} GB</td>
                <td className="py-2 px-3 text-fg-dim">{v.location}</td>
                <td className="py-2 px-3 text-fg-dim">{v.server_name || "—"}</td>
                <td className="py-2 px-3 text-accent-blue font-bold">{v.app_name || "—"}</td>
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
