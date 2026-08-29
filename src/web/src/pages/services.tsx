import { useEffect, useMemo, useState } from "react";
import { Database, Plus } from "lucide-react";
import { get } from "../api/client.ts";
import { approveCliAction, runCliAction } from "../api/cli-actions.ts";
import { Btn, Card, EmptyState, Spinner, StatusBadge, Table, confirm, showToast } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { serverProvisioningResourceId } from "../../../shared/server-provisioning.ts";

type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultVolumeSize: number;
  description?: string;
  stateless?: boolean;
};

type ServiceRow = {
  id: number;
  name: string;
  type: string;
  version: string;
  status: string;
  domain?: string;
  linked_environments?: Array<{ id: number; name: string }>;
};

type Environment = { id: number; name: string };
type ProvisioningDefaults = { server_type: string; location: string };

export function ServicesPage() {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [version, setVersion] = useState("");
  const [volumeSize, setVolumeSize] = useState("");
  const [environment, setEnvironment] = useState("");
  const [envPrefix, setEnvPrefix] = useState("DATABASE");
  const [domain, setDomain] = useState("");
  const [vars, setVars] = useState("");

  const selected = useMemo(() => catalog.find((entry) => entry.type === type), [catalog, type]);

  const load = async () => {
    try {
      const [serviceRows, catalogRows, envRows] = await Promise.all([
        get("/api/services"),
        get("/api/services/catalog"),
        get("/api/environments").catch(() => []),
      ]);
      setServices(serviceRows as ServiceRow[]);
      setCatalog(catalogRows as CatalogEntry[]);
      setEnvironments(envRows as Environment[]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to load services", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!selected) return;
    setVersion(selected.versions[0] || "");
    setVolumeSize(selected.stateless ? "" : String(selected.defaultVolumeSize || ""));
  }, [selected?.type]);

  const createService = async () => {
    if (!name.trim() || !type) return;
    setCreating(true);
    try {
      const defaults = await get("/api/servers/provisioning-defaults") as ProvisioningDefaults;
      const approved = await confirm(
        "Create managed service",
        `Create ${name.trim()} (${selected?.label || type})? If existing capacity is insufficient, OCD may provision one billable ${defaults.server_type} server in ${defaults.location}.`,
        true,
      );
      if (!approved) return;
      const resourceId = serverProvisioningResourceId({
        serverType: defaults.server_type,
        location: defaults.location,
        pools: ["general"],
        reason: `deploying service ${name.trim()}`,
      });
      const confirmationCode = await approveCliAction("create_server", "server_plan", resourceId);
      await runCliAction("services.create", {
        name: name.trim(),
        type,
        version: version || undefined,
        volumeSize: volumeSize || undefined,
        environment: environment || undefined,
        envPrefix: environment ? envPrefix.trim() || undefined : undefined,
        domain: domain.trim() || undefined,
        vars: vars.split(/\r?\n/).map((row) => row.trim()).filter(Boolean),
      }, { confirmationCode });
      showToast("Service deployment started", "success");
      setShowCreate(false);
      setName("");
      setVars("");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to create service", "error");
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-bold uppercase tracking-wider">Managed services</h1>
          <p className="mt-1 text-xs text-muted">Databases, caches, queues, and their environment links.</p>
        </div>
        <PermissionGate permission="services.deploy">
          <Btn variant="primary" onClick={() => setShowCreate((open) => !open)}><Plus size={13} /> New service</Btn>
        </PermissionGate>
      </div>

      {showCreate && (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase">Provision service</h2>
            <p className="mt-1 text-[10px] text-muted">The browser submits this form to the same <span className="font-mono">ocd service create</span> workflow used locally.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="postgres-main" /></label>
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Type</span><NeoSelect value={type} options={catalog.map((entry) => ({ value: entry.type, label: entry.label }))} onChange={setType} placeholder="Select service" /></label>
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Version</span><NeoSelect value={version} options={(selected?.versions || []).map((item) => ({ value: item, label: item }))} onChange={setVersion} placeholder="Catalog default" /></label>
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Volume size (GB)</span><input type="number" min="1" disabled={selected?.stateless} value={volumeSize} onChange={(event) => setVolumeSize(event.target.value)} placeholder={selected?.stateless ? "Stateless" : "Catalog default"} /></label>
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Link environment</span><NeoSelect value={environment} options={[{ value: "", label: "None" }, ...environments.map((env) => ({ value: String(env.id), label: env.name }))]} onChange={setEnvironment} /></label>
            <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Variable prefix</span><input disabled={!environment} value={envPrefix} onChange={(event) => setEnvPrefix(event.target.value)} /></label>
            <label className="space-y-1 md:col-span-2"><span className="font-mono text-[9px] font-bold uppercase">Domain (optional)</span><input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="db.internal.example.com" /></label>
            <label className="space-y-1 md:col-span-2"><span className="font-mono text-[9px] font-bold uppercase">Overrides · one KEY=VALUE per line</span><textarea rows={4} value={vars} onChange={(event) => setVars(event.target.value)} placeholder="MAX_CONNECTIONS=200" /></label>
          </div>
          {selected?.description && <p className="text-[10px] text-muted">{selected.description}</p>}
          <div className="flex justify-end gap-2"><Btn variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Btn><Btn variant="primary" loading={creating} disabled={!name.trim() || !type} onClick={createService}>Create service</Btn></div>
        </Card>
      )}

      {services.length === 0 ? <EmptyState icon={Database} message="No managed services" /> : (
        <Card>
          <Table headers={["Name", "Type", "Version", "Environment", "Status", ""]}>
            {services.map((service) => (
              <tr key={service.id} className="hover:bg-alt/50">
                <td className="px-3 py-3 font-bold"><a href={`#/services/${service.id}`} className="hover:underline">{service.name}</a></td>
                <td className="px-3 py-3">{service.type}</td>
                <td className="px-3 py-3">{service.version || "—"}</td>
                <td className="px-3 py-3">{service.linked_environments?.map((env) => env.name).join(", ") || "—"}</td>
                <td className="px-3 py-3"><StatusBadge status={service.status} /></td>
                <td className="px-3 py-3 text-right"><a href={`#/services/${service.id}`} className="font-mono text-[9px] font-bold uppercase hover:underline">Open</a></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
