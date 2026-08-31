import { Card, StatusBadge, Table, EmptyState } from "../../components/ui.tsx";
import { Boxes, ExternalLink } from "lucide-react";
import type { StackDetail, StackMemberApp, EnvironmentData } from "../../types.ts";

/**
 * The whole stack on one page: what it is configured with and what it contains.
 * Stack configuration is declarative and comes from `ocd-stack.json`.
 */
export function OverviewTab({
  stack,
  memberApps,
  environments,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
  environments: EnvironmentData[];
}) {
  const envName = (id: number | null) =>
    id == null ? null : environments.find((e) => e.id === id)?.name ?? `#${id}`;
  const prodEnv = envName(stack.environment_id);
  const stagingTargets = new Set(
    stack.apps
      .map((app) => app.target_of)
      .filter((id): id is number => id != null),
  );
  const staging = memberApps.filter((app) => stagingTargets.has(app.id)).length;
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Configuration</h3>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="flex justify-between"><span className="text-muted">Created</span><span className="text-fg">{new Date(stack.created_at).toLocaleString()}</span></div>
            <div className="flex justify-between">
              <span className="text-muted">Environment</span>
              {prodEnv
                ? <a href="#/environments" className="text-fg font-bold hover:underline">{prodEnv}</a>
                : <span className="text-fg-dim">none</span>}
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Staging Environment</span>
              <span className="text-fg font-bold">{envName(stack.staging_environment_id) ?? "none"}</span>
            </div>
          </div>
        </Card>
        <Card className="p-4 space-y-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Rollout</h3>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="flex justify-between"><span className="text-muted">Apps</span><span className="text-fg font-bold">{memberApps.length}</span></div>
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
                <td className="py-2 px-3">
                  <StatusBadge
                    status={a.status}
                    subLabel={a.environment_stale ? "stale environment — redeploy required" : undefined}
                  />
                </td>
                <td className="py-2 px-3 font-mono text-[10px]">
                  {a.domain && a.public
                    ? <a href={`https://${a.domain}`} target="_blank" rel="noopener" className="text-accent-blue hover:underline inline-flex items-center gap-1">{a.domain} <ExternalLink size={9} /></a>
                    : <span className="text-fg-dim">private</span>}
                </td>
                <td className="py-2 px-3 font-mono text-[10px] text-fg-dim">
                  {needsOf(a).length ? needsOf(a).join(", ") : "—"}
                </td>
                <td className="py-2 px-3 font-mono text-[10px]">
                  {stagingTargets.has(a.id)
                    ? <span className="text-accent-amber font-bold">on</span>
                    : <span className="text-fg-dim">off</span>}
                </td>
                <td className="py-2 px-3 text-right">
                  <a href={`#/apps/${a.id}`} className="font-mono text-[9px] text-muted hover:text-fg uppercase tracking-wider">Open</a>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

    </div>
  );
}
