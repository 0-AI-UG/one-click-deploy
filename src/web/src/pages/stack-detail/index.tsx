import { useState, useEffect } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, StatusBadge, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { trackOperationInToast, useActiveOperations } from "../../hooks/useOperation.ts";
import { ArrowLeft, RefreshCw, ArrowUpFromLine, Trash2 } from "lucide-react";
import { OverviewTab } from "./overview-tab.tsx";
import { StackLogsTab } from "./logs-tab.tsx";
import type { StackDetail, EnvironmentData } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function StackDetailPage({ stackId }: { stackId: number }) {
  const [stack, setStack] = useState<StackDetail | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Stack ops carry different keys depending on kind: `stack:<id>` (destroy,
  // promote), `stack:<name>` (deploy) and `env:<id>` (redeploy, which fans out
  // via cascade_redeploy on the shared environment). Match all three so any one
  // of them greys out the others — and so a page reload mid-op recovers.
  const ops = useActiveOperations(
    (op) =>
      !!op.resource_keys?.some((k) =>
        k === `stack:${stackId}` ||
        (stack != null && (k === `stack:${stack.name}` || (stack.environment_id != null && k === `env:${stack.environment_id}`))),
      ),
    { rehydrateToasts: true },
  );

  const load = async () => {
    try {
      setStack(await get(`/api/stacks/${stackId}`));
      // The op filter above depends on the stack's name + environment, which we
      // only learn here — re-prime so a reload mid-redeploy finds its op.
      ops.refresh();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [stackId]);
  useEffect(() => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  const action = async (name: string, fn: () => Promise<unknown>) => {
    setActionLoading(name);
    try {
      const result = await fn();
      const opId = result && typeof result === "object" && "op_id" in result
        ? (result as { op_id?: number }).op_id ?? null
        : null;
      if (opId) {
        trackOperationInToast(opId, `${name.charAt(0).toUpperCase() + name.slice(1)} stack`);
        ops.track(opId);
      } else {
        showToast(`${name} successful`, "success");
      }
      load();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (!stack) return <div className="text-center py-20 text-muted font-mono text-[10px] uppercase tracking-wider">Stack not found</div>;

  // Staging siblings are hidden implementation detail of their production app —
  // they belong to the member, not to the stack's member list.
  const memberApps = stack.apps.filter((a) => a.target_of == null);
  const promotable = memberApps.filter((a) => (a.webhook_staging_environment_id ?? null) != null).length;

  // A stack has no settings of its own beyond the staging environment: name and
  // environment are fixed at deploy time, membership comes from the manifest,
  // and redeploy/promote/destroy are in the header. So the staging control lives
  // on Overview and there is no Settings tab.
  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
  ] as const;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}><ArrowLeft size={14} /></Btn>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="font-mono font-bold text-sm text-fg uppercase">{stack.name}</h1>
            <StatusBadge status={stack.status} />
          </div>
          <div className="font-mono text-[9px] text-muted mt-0.5">
            {memberApps.length} app{memberApps.length !== 1 ? "s" : ""} · {stack.services.length} service{stack.services.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex gap-1">
          <PermissionGate permission="stacks.deploy" environmentId={stack.environment_id}>
            <Btn
              size="xs"
              loading={actionLoading === "redeploy" || ops.isBusyWith("cascade_redeploy")}
              disabled={ops.isBusy}
              onClick={() => action("redeploy", () => post(`/api/stacks/${stackId}/redeploy`))}
            ><RefreshCw size={12} /> Redeploy</Btn>
          </PermissionGate>
          {/* Promote only exists when there is something to promote — a stack
              with no staging siblings has no use for the button at all. */}
          {promotable > 0 && (
          <PermissionGate permission="stacks.promote" environmentId={stack.environment_id}>
            <Btn
              size="xs"
              variant="primary"
              disabled={ops.isBusy}
              loading={actionLoading === "promote" || ops.isBusyWith("promote_stack")}
              onClick={async () => {
                if (await confirm(
                  "Promote Stack",
                  `Promote the staging sibling of ${promotable} member(s) of "${stack.name}" to production? Each member is rebuilt from the commit its staging app is running. Members are promoted concurrently, not in dependency order.`,
                )) await action("promote", () => post(`/api/stacks/${stackId}/promote`));
              }}
            ><ArrowUpFromLine size={12} /> Promote</Btn>
          </PermissionGate>
          )}
          <PermissionGate permission="stacks.destroy" environmentId={stack.environment_id}>
            <Btn
              size="xs"
              variant="danger"
              loading={actionLoading === "destroy" || ops.isBusyWith("destroy_stack")}
              disabled={ops.isBusy}
              onClick={async () => {
                if (await confirm(
                  "Destroy Stack",
                  `Permanently destroy "${stack.name}" and all ${memberApps.length} app(s) and ${stack.services.length} service(s)? This removes every member's containers, volumes, and data.`,
                  true,
                )) {
                  await action("destroy", () => del(`/api/stacks/${stackId}`));
                  window.location.hash = "#/";
                }
              }}
            ><Trash2 size={12} /> Destroy</Btn>
          </PermissionGate>
        </div>
      </div>

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab
          stack={stack}
          memberApps={memberApps}
          environments={environments}
          reload={load}
        />
      )}

      {tab === "logs" && <StackLogsTab stackId={stackId} />}
    </div>
  );
}
