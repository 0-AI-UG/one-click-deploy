import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Card, Btn, Table, EmptyState, InfoTip, showToast, confirm, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { HardDrive, Server, Database, Trash2, RefreshCw, Plus, History, Cloud } from "lucide-react";
import type { ResourcesData } from "../types.ts";
import { serverProvisioningResourceId } from "../../../shared/server-provisioning.ts";
import { InfrastructureTools } from "../components/infrastructure-tools.tsx";
import { TabBar } from "../components/tab-bar.tsx";

type ResourceSection = "overview" | "servers" | "volumes" | "object-storage" | "tools";

const RESOURCE_SECTIONS: Array<{ key: ResourceSection; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "servers", label: "Servers" },
  { key: "volumes", label: "Volumes" },
  { key: "object-storage", label: "Object Storage" },
  { key: "tools", label: "Tools" },
];

export function ResourcesPage() {
  const [storageConnection, setStorageConnection] = useState("");
  const [section, setSection] = useState<ResourceSection>("overview");
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
  const [bucketName, setBucketName] = useState("");
  const [bucketBusy, setBucketBusy] = useState<string | null>(null);

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
      const resources = await get(`/api/resources${storageConnection ? `?storage=${encodeURIComponent(storageConnection)}` : ""}`);
      setData(resources);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [storageConnection]);

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

  const handleCreateBucket = async () => {
    const name = bucketName.trim().toLowerCase();
    if (!name) return showToast("Enter a bucket name", "error");
    if (!await confirm("Create S3 Bucket", `Create private bucket "${name}" in ${data?.s3_region || "the configured region"}? Provider billing may apply.`, true)) return;
    setBucketBusy(`create:${name}`);
    try {
      await runConfirmedCliAction(
        "buckets.create",
        { bucket: name, storage: data?.storage_connection },
        { action: "create_bucket", resourceType: "bucket", resourceId: `${data?.storage_connection}:${name}` },
      );
      setBucketName("");
      await load();
      showToast("Bucket created", "success");
    } catch (err: any) {
      showToast(err.message || "Bucket creation failed", "error");
    } finally {
      setBucketBusy(null);
    }
  };

  const handleDeleteBucket = async (name: string) => {
    if (!await confirm("Delete S3 Bucket", `Delete empty bucket "${name}"? OCD will never recursively delete its objects or versions.`, true)) return;
    const typed = window.prompt(`Type the bucket name "${name}" to confirm deletion:`)?.trim();
    if (typed !== name) return showToast("Bucket name did not match; deletion cancelled", "error");
    setBucketBusy(`delete:${name}`);
    try {
      await runConfirmedCliAction(
        "buckets.delete",
        { bucket: name, storage: data?.storage_connection },
        { action: "delete_bucket", resourceType: "bucket", resourceId: `${data?.storage_connection}:${name}`, typedResource: `${data?.storage_connection}:${typed}` },
      );
      await load();
      showToast("Bucket deleted", "success");
    } catch (err: any) {
      showToast(err.message || "Bucket deletion failed", "error");
    } finally {
      setBucketBusy(null);
    }
  };

  const fmtPrice = (eur: number | null | undefined) => {
    if (eur == null) return "—";
    return `€${eur.toFixed(2)}`;
  };

  if (loading) return <PageState title="Loading resources" />;

  return (
    <PageShell>
      <PageHeader title="Resources" description="Servers, volumes, S3 buckets, capacity, and infrastructure cost." actions={<Btn variant="ghost" onClick={async () => {
          setLoading(true);
          try {
            await runCliAction("servers.refresh");
            await load();
            showToast("Provider inventory refreshed", "success");
          } catch (error) {
            showToast(error instanceof Error ? error.message : "Refresh failed", "error");
            setLoading(false);
          }
        }}><RefreshCw size={13} /> Refresh inventory</Btn>} />

      <TabBar tabs={RESOURCE_SECTIONS} active={section} onChange={setSection} />

      {/* Cost estimate */}
      {section === "overview" && data?.totals && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-1">Estimated Monthly Cost <InfoTip text="Estimates use the configured infrastructure provider's list prices. Excludes traffic overage and snapshots." /></h3>
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

      {section === "overview" && (
        <Card className="overflow-hidden">
          {[
            { key: "servers" as const, label: "Servers", value: `${data?.servers?.length || 0} connected resources` },
            { key: "volumes" as const, label: "Volumes", value: `${data?.volumes?.length || 0} attached or retained provider volumes` },
            {
              key: "object-storage" as const,
              label: "Object Storage",
              value: data?.s3_configured
                ? `${data.buckets?.length || 0} buckets · ${data.s3_region}`
                : "Not configured",
            },
            { key: "tools" as const, label: "Tools", value: "Build workers, server enrollment, and disk cleanup" },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className="flex w-full items-center justify-between gap-4 border-b border-fg/10 px-4 py-3 text-left last:border-b-0 hover:bg-alt/50"
            >
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider">{item.label}</span>
              <span className="font-mono text-[9px] text-muted text-right">{item.value}</span>
            </button>
          ))}
        </Card>
      )}

      {/* Servers */}
      {section === "servers" && <Card className="p-4">
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
                <td className="py-2 px-3"><span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{s.provider || "manual"}</span></td>
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
      </Card>}

      {/* Object storage */}
      {section === "object-storage" && <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Cloud size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">S3 Buckets ({data?.buckets?.length || 0})</h3>
          {data?.s3_configured && <span className="font-mono text-[8px] text-muted uppercase">S3 · {data.s3_region}</span>}
        </div>
        <label className="block mb-3 font-mono text-[10px]">Storage connection
          <select value={storageConnection || data?.storage_connection || ""} onChange={e => setStorageConnection(e.target.value)} disabled={!!bucketBusy}>
            {(data?.storage_connections || []).map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.region}</option>)}
          </select>
        </label>
        {!data?.s3_configured ? (
          <EmptyState message="S3-compatible storage is not configured. Add and assign a provider under Admin → Providers." />
        ) : data.s3_error ? (
          <div className="border-2 border-accent-red bg-accent-red/10 p-3 font-mono text-[10px] text-accent-red">{data.s3_error}</div>
        ) : (
          <>
            <PermissionGate permission="buckets.create">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={bucketName}
                  onChange={(event) => setBucketName(event.target.value)}
                  placeholder="globally-unique-bucket-name"
                  className="min-w-0 flex-1 font-mono text-[10px]"
                />
                <Btn size="xs" onClick={handleCreateBucket} loading={bucketBusy?.startsWith("create:") === true} disabled={!bucketName.trim()}>
                  <Plus size={11} /> Create private bucket
                </Btn>
              </div>
            </PermissionGate>
            {!data.buckets.length ? <EmptyState message="No buckets in this region" /> : (
              <Table headers={["Name", "Region", "Created", "Endpoint", ""]}>
                {data.buckets.map((bucket) => (
                  <tr key={bucket.name} className="hover:bg-alt/50">
                    <td className="py-2 px-3 font-bold">{bucket.name}</td>
                    <td className="py-2 px-3 text-fg-dim">{bucket.region}</td>
                    <td className="py-2 px-3 text-fg-dim">{bucket.createdAt ? new Date(bucket.createdAt).toLocaleString() : "—"}</td>
                    <td className="py-2 px-3 font-mono text-[9px] text-fg-dim">{bucket.endpoint}</td>
                    <td className="py-2 px-3">
                      <PermissionGate permission="buckets.delete">
                        <Btn size="xs" variant="danger" loading={bucketBusy === `delete:${bucket.name}`} onClick={() => handleDeleteBucket(bucket.name)}>
                          <Trash2 size={11} />
                        </Btn>
                      </PermissionGate>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Card>}

      {/* Volumes */}
      {section === "volumes" && <Card className="p-4">
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
        <p className="text-xs text-muted mb-3">Provider block volumes only. Server-local directories share the server disk and appear under each server’s Storage and the app’s Storage.</p>
        {!data?.volumes?.length ? <EmptyState message="No provider volumes" /> : (
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
      </Card>}

      {section === "tools" && <InfrastructureTools />}
    </PageShell>
  );
}
