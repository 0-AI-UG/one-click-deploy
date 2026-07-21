import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Card, Btn, StatusBadge, Table, EmptyState, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { InfoTip } from "../app-detail/shared.tsx";
import { Boxes, Database, ExternalLink, Link2, Unlink, Plus } from "lucide-react";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { StackDetail, StackMemberApp, EnvironmentData } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

type Candidate = { id: number; name: string; stack_id?: number | null; target_of?: number | null };

/**
 * The stack at a glance, and the only place its membership is edited.
 *
 * These were two tabs and read as one page twice: both listed the same apps and
 * services, differing only in whether the row ended in a Detach button. The
 * member list IS the overview of a stack, so the tables carry the actions.
 *
 * Membership itself is one nullable column (`apps.stack_id` /
 * `services.stack_id`) — attaching and detaching here is metadata only, nothing
 * is built, moved or destroyed. The authoritative way to change what a stack
 * contains is `ocd-stack.json` plus a re-sync (Settings); this is the escape
 * hatch for what the manifest leaves behind.
 */
export function OverviewTab({
  stack,
  memberApps,
  environments,
  reload,
  ops,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
  environments: EnvironmentData[];
  reload: () => void;
  ops: ResourceOpsResult;
}) {
  const [apps, setApps] = useState<Candidate[]>([]);
  const [services, setServices] = useState<Candidate[]>([]);
  const [addKind, setAddKind] = useState<"app" | "service">("app");
  const [addId, setAddId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    get("/api/dashboard")
      .then((d: { apps: Candidate[]; services: Candidate[] }) => {
        setApps(d.apps || []);
        setServices(d.services || []);
      })
      .catch(() => {});
  }, [stack.id]);

  const envName = (id: number | null) =>
    id == null ? null : environments.find((e) => e.id === id)?.name ?? `#${id}`;
  const prodEnv = envName(stack.environment_id);
  const stagingEnv = envName(stack.staging_environment_id);
  const staging = memberApps.filter((a) => (a.webhook_staging_environment_id ?? null) != null).length;
  // Every member is deployed from the same repo (the one holding ocd-stack.json),
  // so the first member's repo is the stack's source of truth.
  const repo = memberApps.find((a) => a.git_repo)?.git_repo;
  // `needs` edges from the stack manifest, persisted per member. They are what
  // orders deploys and promotes into levels, so they belong on this page even
  // though they're only editable in `ocd-stack.json`.
  const needsOf = (a: StackMemberApp): string[] => {
    try {
      const parsed = a.stack_needs ? JSON.parse(a.stack_needs) : [];
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  };

  // Only unattached, top-level resources can join: a staging sibling follows its
  // production app, and stealing a member from another stack would silently
  // break that stack's promote/redeploy fan-out.
  const free = (addKind === "app" ? apps : services).filter(
    (r) => r.stack_id == null && r.target_of == null,
  );

  const addMember = async () => {
    const id = parseInt(addId, 10);
    if (!id) return;
    setBusy("add");
    try {
      await post(`/api/stacks/${stack.id}/members`, { kind: addKind, id });
      showToast(`Added ${addKind} to stack`, "success");
      setAddId("");
      reload();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const detach = async (kind: "apps" | "services", id: number, name: string) => {
    if (!(await confirm(
      "Detach from Stack",
      `Remove "${name}" from "${stack.name}"? It keeps running with its current config and moves back to the dashboard's top level. Nothing is destroyed.`,
    ))) return;
    setBusy(`${kind}-${id}`);
    try {
      await del(`/api/stacks/${stack.id}/members/${kind}/${id}`);
      showToast(`Detached ${name}`, "success");
      reload();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
          <div className="space-y-2 text-[10px] font-mono">
            {repo && <div className="flex justify-between gap-4"><span className="text-muted">Source Repo</span><span className="text-fg font-bold truncate">{repo}</span></div>}
            <div className="flex justify-between"><span className="text-muted">Created</span><span className="text-fg">{new Date(stack.created_at).toLocaleString()}</span></div>
            <div className="flex justify-between">
              <span className="text-muted">Environment</span>
              {prodEnv
                ? <a href="#/environments" className="text-fg font-bold hover:underline">{prodEnv}</a>
                : <span className="text-fg-dim">none</span>}
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Staging Environment</span>
              {stagingEnv
                ? <a href="#/environments" className="text-fg font-bold hover:underline">{stagingEnv}</a>
                : <span className="text-fg-dim">none</span>}
            </div>
          </div>
        </Card>
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Rollout</h3>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="flex justify-between"><span className="text-muted">Apps</span><span className="text-fg font-bold">{memberApps.length}</span></div>
            <div className="flex justify-between"><span className="text-muted">Services</span><span className="text-fg font-bold">{stack.services.length}</span></div>
            <div className="flex justify-between">
              <span className="text-muted">Members on staging</span>
              <span className={staging > 0 ? "text-accent-amber font-bold" : "text-fg-dim"}>
                {staging > 0 ? `${staging} of ${memberApps.length}` : "none"}
              </span>
            </div>
            <div className="flex justify-between"><span className="text-muted">Status</span><span className="text-fg">{stack.status}</span></div>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Boxes size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Apps ({memberApps.length})</h3>
        </div>
        {memberApps.length === 0 ? (
          <EmptyState message="This stack has no apps." icon={Boxes} />
        ) : (
          <Table headers={["Name", "Status", "Domain", "Needs", "Staging", ""]}>
            {memberApps.map((a) => (
              <tr key={a.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a href={`#/apps/${a.id}`} className="font-mono text-[10px] font-bold text-fg hover:underline">{a.name}</a>
                </td>
                <td className="py-2 px-3"><StatusBadge status={a.status} /></td>
                <td className="py-2 px-3 font-mono text-[10px]">
                  {a.domain && a.public
                    ? <a href={`https://${a.domain}`} target="_blank" rel="noopener" className="text-accent-blue hover:underline inline-flex items-center gap-1">{a.domain} <ExternalLink size={9} /></a>
                    : <span className="text-fg-dim">private</span>}
                </td>
                <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">
                  {needsOf(a).length ? needsOf(a).join(", ") : "—"}
                </td>
                <td className="py-2 px-3 font-mono text-[10px]">
                  {(a.webhook_staging_environment_id ?? null) != null
                    ? <span className="text-accent-amber font-bold">on</span>
                    : <span className="text-fg-dim">off</span>}
                </td>
                <td className="py-2 px-3">
                  <div className="flex items-center justify-end gap-2">
                    <a href={`#/apps/${a.id}`} className="font-mono text-[9px] text-muted hover:text-fg uppercase tracking-wider">Open</a>
                    <PermissionGate permission="stacks.deploy">
                      <Btn
                        size="xs"
                        disabled={ops.isBusy}
                        loading={busy === `apps-${a.id}`}
                        onClick={() => detach("apps", a.id, a.name)}
                      ><Unlink size={12} /> Detach</Btn>
                    </PermissionGate>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Services ({stack.services.length})</h3>
        </div>
        {stack.services.length === 0 ? (
          <EmptyState message="This stack has no services." icon={Database} />
        ) : (
          <Table headers={["Name", "Type", "Version", "Status", ""]}>
            {stack.services.map((s) => (
              <tr key={s.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a href={`#/services/${s.id}`} className="font-mono text-[10px] font-bold text-fg hover:underline">{s.name}</a>
                </td>
                <td className="py-2 px-3 font-mono text-[10px] text-fg">{s.service_type}</td>
                <td className="py-2 px-3 font-mono text-[10px] text-muted">{s.version}</td>
                <td className="py-2 px-3"><StatusBadge status={s.status} /></td>
                <td className="py-2 px-3">
                  <div className="flex items-center justify-end gap-2">
                    <a href={`#/services/${s.id}`} className="font-mono text-[9px] text-muted hover:text-fg uppercase tracking-wider">Open</a>
                    <PermissionGate permission="stacks.deploy">
                      <Btn
                        size="xs"
                        disabled={ops.isBusy}
                        loading={busy === `services-${s.id}`}
                        onClick={() => detach("services", s.id, s.name)}
                      ><Unlink size={12} /> Detach</Btn>
                    </PermissionGate>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <PermissionGate permission="stacks.deploy">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Link2 size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">
              Attach Existing <InfoTip text="Tags an existing app or service as a member. Metadata only — it is not rebuilt, moved to the stack environment, or given a place in the needs order. For that, add it to ocd-stack.json and re-sync from Settings." />
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-32">
              <NeoSelect
                value={addKind}
                onChange={(v) => { setAddKind(v as "app" | "service"); setAddId(""); }}
                options={[{ value: "app", label: "App" }, { value: "service", label: "Service" }]}
                compact
              />
            </div>
            <div className="flex-1 min-w-[12rem]">
              <NeoSelect
                value={addId}
                onChange={setAddId}
                options={[
                  { value: "", label: free.length ? `Select ${addKind}…` : `No unattached ${addKind}s` },
                  ...free.map((r) => ({ value: String(r.id), label: r.name })),
                ]}
                compact
              />
            </div>
            <Btn size="xs" variant="primary" disabled={!addId} loading={busy === "add"} onClick={addMember}>
              <Plus size={12} /> Attach
            </Btn>
          </div>
        </Card>
      </PermissionGate>
    </div>
  );
}
