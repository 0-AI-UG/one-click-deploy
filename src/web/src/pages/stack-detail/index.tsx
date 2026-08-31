import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { runConfirmedCliAction } from "../../api/cli-actions.ts";
import { Btn, StatusBadge, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { trackOperationInToast, useActiveOperations } from "../../hooks/useOperation.ts";
import { ArrowLeft, ArrowUpFromLine, Trash2 } from "lucide-react";
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
  // Stack ops use an id for lifecycle actions and a name for manifest deploys.
  const ops = useActiveOperations(
    (op) =>
      !!op.resource_keys?.some((k) =>
        k === `stack:${stackId}` ||
        (stack != null && k === `stack:${stack.name}`),
      ),
    { rehydrateToasts: true },
  );

  const load = async () => {
    try {
      setStack(await get(`/api/stacks/${stackId}`));
      // The op filter above depends on the stack's name + environment, which we
      // only learn here, so re-prime after loading it.
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
  const stagingTargets = new Set(
    stack.apps.map((app) => app.target_of).filter((id): id is number => id != null),
  );
  const promotable = memberApps.filter((app) => stagingTargets.has(app.id)).length;

  // Stack configuration and membership come exclusively from ocd-stack.json.
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
            {memberApps.length} app{memberApps.length !== 1 ? "s" : ""}
          </div>
          {stack.last_operation_id != null && (
            <>
              <div className={`font-mono text-[9px] mt-0.5 ${stack.last_operation_failed ? "text-danger" : "text-muted"}`}>
                Last stack operation #{stack.last_operation_id}: {stack.last_operation_status}
                {stack.operation_in_progress ? " (in progress)" : ""}
              </div>
              {(stack.last_operation_children || []).length > 0 && (
                <div className="font-mono text-[9px] text-muted mt-0.5">
                  Children: {stack.last_operation_children!.map((child) => `#${child.id} ${child.status}`).join(", ")}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex gap-1">
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
                  `Promote the staging sibling of ${promotable} member(s) of "${stack.name}" to production? Each production app will receive the exact immutable image running in staging.`,
                )) await action("promote", () => runConfirmedCliAction(
                  "stacks.promote",
                  { stack: String(stackId) },
                  { action: "promote_stack", resourceType: "stack", resourceId: stackId },
                ));
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
                  `Destroy "${stack.name}" and all ${memberApps.length} app(s)? Containers and routing are removed; environments are retained, and managed volumes are detached for recovery.`,
                  true,
                )) {
                  await action("destroy", () => runConfirmedCliAction(
                    "stacks.delete",
                    { stack: String(stackId) },
                    { action: "delete_stack", resourceType: "stack", resourceId: stackId },
                  ));
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
        />
      )}

      {tab === "logs" && <StackLogsTab stackId={stackId} />}
    </div>
  );
}
