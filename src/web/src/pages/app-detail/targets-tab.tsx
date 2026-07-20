import { useState, useEffect } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, Table, Spinner, EmptyState, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import { GitBranch, ArrowUpCircle } from "lucide-react";
import type { AppTargetsResponse } from "../../../../shared/rpc.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface TargetsTabProps {
  app: { id: number; name: string };
  // Shared op-runner from AppDetailPage: tracks op_id in a toast + ops store
  // (identical to how rollback is surfaced from the Deployments tab).
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

const badgeClass = "font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5 bg-alt text-fg";

export function TargetsTab({ app, action, ops }: TargetsTabProps) {
  const [data, setData] = useState<AppTargetsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await get(`/api/apps/${app.id}/targets`));
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [app.id]);

  const promote = async (sourceName: string, destName: string) => {
    if (await confirm(
      "Promote to Production",
      `Promote ${sourceName} to ${destName}? This rebuilds production at the commit currently running in ${sourceName}.`,
    )) {
      await action("promote", () => post("/api/apps/promote", { source_app: sourceName, dest_app: destName }));
      load();
    }
  };

  if (loading || !data) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  const { self, targets } = data;
  const isSibling = self.target !== "" && self.target !== "production";

  // This app IS a target sibling (e.g. "<base>-staging"): offer promotion of
  // itself up to its production parent. The parent resolved from target_of is
  // authoritative; the name-suffix strip is only a fallback for legacy rows
  // without the link — and only when it actually yields a different name.
  if (isSibling) {
    const suffix = `-${self.target}`;
    const stripped = self.name.endsWith(suffix) ? self.name.slice(0, -suffix.length) : self.name;
    const destName = self.parent?.name ?? (stripped !== self.name ? stripped : null);
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deploy Target</h3>
        </div>
        <p className="text-xs text-fg-dim mb-4">
          This is the <span className="font-mono font-bold text-fg">{self.target}</span> target
          {destName ? (
            <> of <span className="font-mono font-bold text-fg">{destName}</span>.</>
          ) : (
            <> (no production parent found to promote to).</>
          )}
        </p>
        {destName && (
          <PermissionGate permission="apps.deploy">
            <Btn
              variant="primary"
              disabled={ops.isBusy}
              loading={ops.isBusyWith("promote")}
              onClick={() => promote(self.name, destName)}
            >
              <ArrowUpCircle size={13} /> Promote to Production
            </Btn>
          </PermissionGate>
        )}
      </Card>
    );
  }

  // This app is a base/production app: list its staging/dev siblings, each
  // promotable back up to this app.
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <GitBranch size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deploy Targets</h3>
      </div>
      {targets.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          message="No targets — deploy one from the deploy page with a target selected, or run ocd deploy --target=staging"
        />
      ) : (
        <Table headers={["Name", "Target", "Status", "Domain", ""]}>
          {targets.map((t) => (
            <tr key={t.id} className="hover:bg-alt/50">
              <td className="py-2 px-3 text-fg font-bold">{t.name}</td>
              <td className="py-2 px-3"><span className={badgeClass}>{t.target}</span></td>
              <td className="py-2 px-3"><StatusBadge status={t.status} /></td>
              <td className="py-2 px-3 text-fg-dim">
                {t.domain
                  ? <a href={`https://${t.domain}`} target="_blank" rel="noreferrer" className="hover:text-fg underline">{t.domain}</a>
                  : <span className="text-muted">—</span>}
              </td>
              <td className="py-2 px-3">
                <PermissionGate permission="apps.deploy">
                  <Btn
                    size="xs" variant="ghost"
                    disabled={ops.isBusy}
                    loading={ops.isBusyWith("promote")}
                    onClick={() => promote(t.name, self.name)}
                  >
                    <ArrowUpCircle size={12} /> Promote → production
                  </Btn>
                </PermissionGate>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
