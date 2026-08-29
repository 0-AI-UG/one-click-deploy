import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Card, Btn, Table, EmptyState, Spinner, showToast, confirm } from "../components/ui.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { HardDrive, Server, Database, Trash2, RefreshCw, Plus, History } from "lucide-react";
import { InfoTip } from "./app-detail/shared.tsx";
import type { ResourcesData } from "../types.ts";
import { serverProvisioningResourceId } from "../../../shared/server-provisioning.ts";
import { InfrastructureTools } from "../components/infrastructure-tools.tsx";

export function ResourcesPage() {
  const [data, setData] = useState<ResourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [volumeAudit, setVolumeAudit] = useState<Array<{
    id: number; requested_at: string; provider_volume_id: string; provider_volume_name: string;
    former_resource_name: string; status: string; actor_user_id: string; error: string;
  }> | null>(null);

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
    if (!await confirm(
      "Create Server",
      `Create a billable ${createType} server in ${createLocation}${createName ? ` named "${createName}"` : ""}?`,
      true,
    )) return;
    setCreating(true);
    try {
      const planId = serverProvisioningResourceId({
        serverType: createType,
        location: createLocation,
        pools: ["general"],
        reason: createName ? `server ${createName}` : "an explicitly requested server",
      });
      await runConfirmedCliAction(
        "servers.create",
        { type: createType, location: createLocation, name: createName || undefined },
        { action: "create_server", resourceType: "server_plan", resourceId: planId },
      );
      showToast("Server provisioned", "success");
      setShowCreate(false);
      setCreateType("");
      setCreateLocation("");
      setCreateName("");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
      setCreateProgress("");
    }
  };

  const load = async () => {
    try {
      const resources = await get("/api/resources");
      setData(resources);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (type: string, id: string, name: string) => {
    const connectedServer = type === "server" && data?.servers.find((server) => String(server.id) === id)?.ownership === "connected";
    const verb = connectedServer ? "Disconnect" : "Delete";
    const consequence = connectedServer
      ? "The VPS itself will not be changed or deleted."
      : "This cannot be undone.";
    if (!await confirm(`${verb} Resource`, `${verb} ${type.replace("_", " ")} "${name}"? ${consequence}`, !connectedServer)) return;
    let typedVolumeId: string | undefined;
    if (type === "volume") {
      typedVolumeId = window.prompt(`Type the provider volume ID "${id}" to permanently delete its data:`)?.trim();
      if (typedVolumeId !== id) {
        showToast("Volume ID did not match; deletion cancelled", "error");
        return;
      }
    }
    const key = `${type}-${id}`;
    setDeleting(key);
    try {
      if (type === "volume") {
        await runConfirmedCliAction(
          "volumes.delete",
          { volume: id },
          { action: "delete_volume", resourceType: "volume", resourceId: id, typedResource: typedVolumeId },
        );
      } else {
        await runConfirmedCliAction(
          "servers.delete",
          { server: id },
          { action: "delete_server", resourceType: "server", resourceId: id },
        );
      }
      showToast(`${name} ${connectedServer ? "disconnected" : "deleted"}`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setDeleting(null);
    }
  };

  const toggleVolumeAudit = async () => {
    if (volumeAudit) {
      setVolumeAudit(null);
      return;
    }
    try {
      setVolumeAudit(await get("/api/resources/volumes/deletion-audit"));
    } catch (err: any) {
      showToast(err.message || "Failed to load deletion audit", "error");
    }
  };

  const fmtPrice = (eur: number | null | undefined) => {
    if (eur == null) return "—";
    return `€${eur.toFixed(2)}`;
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Resources</h1>
        </div>
        <Btn variant="ghost" onClick={async () => {
          setLoading(true);
          try {
            await runCliAction("servers.refresh");
            await load();
            showToast("Provider inventory refreshed", "success");
          } catch (error) {
            showToast(error instanceof Error ? error.message : "Refresh failed", "error");
            setLoading(false);
          }
        }}><RefreshCw size={13} /> Refresh inventory</Btn>
      </div>

      {/* Cost estimate */}
      {data?.totals && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-1">Estimated Monthly Cost <InfoTip text="Estimates based on Hetzner's list prices. Excludes traffic overage and snapshots." /></h3>
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
        </Card>
      )}

      {/* Servers */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Server size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Servers ({data?.servers?.length || 0})</h3>
          <div className="ml-auto relative" ref={popoverRef}>
            <PermissionGate permission="servers.create">
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
                  disabled={!createType}
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
          <Table headers={["Name", "Provider", "Ownership", "Replicas", "Disk", "€/mo", ""]}>
            {data.servers.map((s) => (
              <tr key={s.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a
                    href={`#/resources/servers/${s.id}`}
                    className="text-fg font-bold hover:text-accent-blue hover:underline"
                  >
                    {s.name}
                  </a>
                </td>
                <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{s.provider}</span></td>
                <td className="py-2 px-3 text-fg-dim">{s.ownership}</td>
                <td className="py-2 px-3 text-fg-dim">{s.replica_count}</td>
                <td className="py-2 px-3 font-mono text-[10px]">
                  {s.disk_free_gb != null && s.disk_total_gb != null ? (
                    <span
                      className={
                        s.disk_free_gb < 2
                          ? "text-accent-red font-bold"
                          : s.disk_free_gb < 5
                            ? "text-accent-amber font-bold"
                            : "text-fg-dim"
                      }
                      title={`${s.disk_used_gb} / ${s.disk_total_gb} GB used`}
                    >
                      {s.disk_free_gb}<span className="text-muted">/{s.disk_total_gb}</span><span className="text-muted ml-0.5">GB</span>
                    </span>
                  ) : "—"}
                </td>
                <td className="py-2 px-3 text-fg font-bold">{fmtPrice(s.monthly_eur)}</td>
                <td className="py-2 px-3">
                  <PermissionGate permission="resources.delete">
                    <Btn
                      size="xs"
                      variant="danger"
                      disabled={s.replica_count > 0}
                      title={s.replica_count > 0 ? "In use by replicas" : undefined}
                      loading={deleting === `server-${s.id}` || !!ops.byResourceKey(`server:${s.id}`)}
                      onClick={() => handleDelete("server", String(s.id), s.name)}
                    >
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
          <div className="ml-auto">
            <PermissionGate permission="volumes.delete">
              <Btn size="xs" variant="ghost" onClick={toggleVolumeAudit}>
                <History size={11} /> {volumeAudit ? "Hide audit" : "Deletion audit"}
              </Btn>
            </PermissionGate>
          </div>
        </div>
        {!data?.volumes?.length ? <EmptyState message="No volumes" /> : (
          <Table headers={["Name", "State", "Size", "Location", "Server", "App", "€/mo", ""]}>
            {data.volumes.map((v) => (
              <tr key={v.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a
                    href={`#/resources/volumes/${encodeURIComponent(v.id)}`}
                    className="text-fg font-bold hover:text-accent-blue hover:underline"
                  >
                    {v.name}
                  </a>
                </td>
                <td className="py-2 px-3 text-fg-dim">
                  {v.retired_state
                    ? v.retention_class === "provisional"
                      ? `provisional until ${String(v.purge_after || "").slice(0, 10)}; auto-cleanup (${v.retired_from})`
                      : `retained; review ${String(v.purge_after || "").slice(0, 10)} (${v.retired_from})`
                    : "attached"}
                </td>
                <td className="py-2 px-3 text-fg-dim">{v.size} GB</td>
                <td className="py-2 px-3 text-fg-dim">{v.location}</td>
                <td className="py-2 px-3 text-fg-dim">{v.server_name || "—"}</td>
                <td className="py-2 px-3 text-accent-blue font-bold">{v.app_name || "—"}</td>
                <td className="py-2 px-3 text-fg font-bold">{fmtPrice(v.monthly_eur)}</td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-1">
                    <PermissionGate permission="volumes.delete">
                      <Btn size="xs" variant="danger" disabled={!!v.app_name} title={v.app_name ? `In use by ${v.app_name}` : undefined} loading={deleting === `volume-${v.id}`} onClick={() => handleDelete("volume", v.id, v.name)}>
                        <Trash2 size={11} />
                      </Btn>
                    </PermissionGate>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {volumeAudit && (
          <div className="mt-4">
            <h4 className="font-mono text-[9px] font-bold uppercase mb-2">Permanent deletion audit</h4>
            {volumeAudit.length === 0 ? (
              <div className="font-mono text-[9px] text-muted">No deletion attempts recorded.</div>
            ) : (
              <Table headers={["Requested", "Volume", "Former owner", "Status", "Actor", "Error"]}>
                {volumeAudit.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 px-3 text-fg-dim">{row.requested_at}</td>
                    <td className="py-2 px-3 font-bold">{row.provider_volume_name} <span className="text-muted">#{row.provider_volume_id}</span></td>
                    <td className="py-2 px-3 text-fg-dim">{row.former_resource_name || "—"}</td>
                    <td className="py-2 px-3">{row.status}</td>
                    <td className="py-2 px-3 text-fg-dim">{row.actor_user_id}</td>
                    <td className="py-2 px-3 text-accent-red">{row.error || "—"}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </Card>

      <InfrastructureTools />
    </div>
  );
}
