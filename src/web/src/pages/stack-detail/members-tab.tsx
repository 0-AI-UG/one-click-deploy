import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Card, Btn, StatusBadge, Table, EmptyState, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Boxes, Database, Link2, Unlink, Plus } from "lucide-react";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { StackDetail, StackMemberApp } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

type Candidate = { id: number; name: string; stack_id?: number | null; target_of?: number | null };

/**
 * Membership editor. Membership is one nullable column (`apps.stack_id` /
 * `services.stack_id`), so attaching and detaching here is metadata only —
 * nothing is built, moved, or destroyed, and a detached app keeps running and
 * reappears at the dashboard's top level.
 *
 * This is the escape hatch, not the main road: the authoritative way to change
 * what a stack contains is to edit `ocd-stack.json` and re-deploy the stack
 * (Settings → Re-sync from manifest), which also wires env vars and `needs`
 * ordering. Attaching here does neither.
 */
export function MembersTab({
  stack,
  memberApps,
  reload,
  ops,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
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
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Link2 size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Add Existing Resource</h3>
        </div>
        <p className="font-mono text-[9px] text-muted mb-3">
          Tags an existing app or service as a member. Metadata only — it is not rebuilt, moved to the
          stack environment, or given a place in the <span className="text-fg">needs</span> order. For that,
          add it to <span className="text-fg">ocd-stack.json</span> and re-sync from Settings.
        </p>
        <PermissionGate permission="stacks.deploy">
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
              <Plus size={12} /> Add
            </Btn>
          </div>
        </PermissionGate>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Boxes size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Apps ({memberApps.length})</h3>
        </div>
        {memberApps.length === 0 ? (
          <EmptyState message="This stack has no apps." icon={Boxes} />
        ) : (
          <Table headers={["Name", "Status", "Domain", ""]}>
            {memberApps.map((a) => (
              <tr key={a.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a href={`#/apps/${a.id}`} className="font-mono text-[10px] font-bold text-fg hover:underline">{a.name}</a>
                </td>
                <td className="py-2 px-3"><StatusBadge status={a.status} /></td>
                <td className="py-2 px-3 text-fg-dim">{a.domain || "private"}</td>
                <td className="py-2 px-3 text-right">
                  <PermissionGate permission="stacks.deploy">
                    <Btn
                      size="xs"
                      disabled={ops.isBusy}
                      loading={busy === `apps-${a.id}`}
                      onClick={() => detach("apps", a.id, a.name)}
                    ><Unlink size={12} /> Detach</Btn>
                  </PermissionGate>
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
          <Table headers={["Name", "Type", "Status", ""]}>
            {stack.services.map((s) => (
              <tr key={s.id} className="hover:bg-alt/50">
                <td className="py-2 px-3">
                  <a href={`#/services/${s.id}`} className="font-mono text-[10px] font-bold text-fg hover:underline">{s.name}</a>
                </td>
                <td className="py-2 px-3 text-fg-dim">{s.service_type} {s.version}</td>
                <td className="py-2 px-3"><StatusBadge status={s.status} /></td>
                <td className="py-2 px-3 text-right">
                  <PermissionGate permission="stacks.deploy">
                    <Btn
                      size="xs"
                      disabled={ops.isBusy}
                      loading={busy === `services-${s.id}`}
                      onClick={() => detach("services", s.id, s.name)}
                    ><Unlink size={12} /> Detach</Btn>
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
