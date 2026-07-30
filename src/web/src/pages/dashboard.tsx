import { useState, useEffect, useRef } from "react";
import { get, post, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, EmptyState, Spinner, showToast, confirm, CopyButton } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { Globe, GitBranch, RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink, ScrollText, Check, Database, Box, Boxes, ChevronDown, ChevronRight, Table2, Share2, ArrowUpFromLine } from "lucide-react";
import { TopologyGraph, type TopologyData } from "../components/topology-graph.tsx";
import { serverConfirmedDelete } from "../api/server-confirmation.ts";

type AppData = {
  id: number; name: string; domain: string; git_repo: string; status: string;
  container_port: number; webhook_enabled: number;
  desired_replicas: number; volume_id: string;
  public: number; health_check: number;
  internal_protocol?: string;
  stack_id?: number | null;
  environment_stale?: number;
  // Carried purely so per-app controls can be gated against an
  // environment-scoped grant as well as an app-scoped one.
  environment_id?: number | null;
};
type ServiceData = {
  id: number; name: string; service_type: string; version: string; status: string;
  linked_environments: Array<{ id: number; name: string }>;
  stack_id?: number | null;
};
type StackData = {
  id: number; name: string; status: string; created_at: string;
  environment_id: number | null; app_count: number; service_count: number;
  // Production members that currently have a webhook-staging sibling. 0 = the
  // "Promote staging" bulk action has nothing to do.
  staging_sibling_count?: number;
};
type DashboardData = { apps: AppData[]; services: ServiceData[] };

const APP_OP_KINDS = new Set([
  "restart_app", "pause_app", "unpause_app", "redeploy", "destroy_app",
]);
const SVC_OP_KINDS = new Set([
  "restart_service", "pause_service", "unpause_service", "destroy_service",
]);
const STACK_OP_KINDS = new Set([
  "deploy_stack", "destroy_stack", "cascade_redeploy", "promote_stack",
]);

const APP_OP_LABELS: Record<string, string> = {
  restart: "Restarting app",
  pause: "Pausing app",
  unpause: "Unpausing app",
  redeploy: "Redeploying app",
  delete: "Destroying app",
};
const SVC_OP_LABELS: Record<string, string> = {
  restart: "Restarting service",
  pause: "Pausing service",
  unpause: "Unpausing service",
  delete: "Destroying service",
};
const APP_ACTION_TO_KIND: Record<string, string> = {
  restart: "restart_app",
  pause: "pause_app",
  unpause: "unpause_app",
  redeploy: "redeploy",
  delete: "destroy_app",
};
const SVC_ACTION_TO_KIND: Record<string, string> = {
  restart: "restart_service",
  pause: "pause_service",
  unpause: "unpause_service",
  delete: "destroy_service",
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>({ apps: [], services: [] });
  const [stacks, setStacks] = useState<StackData[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const seenStacks = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);
  const [view, setView] = useState<"table" | "graph">("table");
  const [topo, setTopo] = useState<TopologyData | null>(null);
  const [topoLoading, setTopoLoading] = useState(false);

  const loadTopo = async () => {
    setTopoLoading(true);
    try {
      setTopo(await get("/api/topology") as TopologyData);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setTopoLoading(false);
    }
  };

  const ops = useActiveOperations(
    (op) => APP_OP_KINDS.has(op.kind) || SVC_OP_KINDS.has(op.kind) || STACK_OP_KINDS.has(op.kind),
    { rehydrateToasts: true },
  );

  const armOrRun = (key: string, run: () => void) => {
    if (confirmKey === key) {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(null);
      run();
    } else {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(key);
      confirmTimeoutRef.current = window.setTimeout(() => setConfirmKey(null), 3000);
    }
  };

  const load = async () => {
    try {
      const [dash, stackList] = await Promise.all([
        get("/api/dashboard") as Promise<DashboardData>,
        get("/api/stacks") as Promise<StackData[]>,
      ]);
      setData(dash);
      setStacks(stackList);
      // Auto-expand a stack the first time we see it; preserve the user's
      // collapse choices across the reconciler's polling reloads.
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const s of stackList) {
          if (!seenStacks.current.has(s.id)) {
            seenStacks.current.add(s.id);
            next.add(s.id);
          }
        }
        return next;
      });
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Refetch state whenever the set of active ops changes — catches both enqueue
  // (op appears) and terminal (op drops out after ~2s linger).
  const activeSig = ops.active.map((o) => `${o.id}:${o.status}`).join(",");
  useEffect(() => {
    if (!loading) load();
    if (!loading && view === "graph") loadTopo();
  }, [activeSig]);

  // Fetch the topology lazily the first time the graph view is opened.
  useEffect(() => {
    if (view === "graph" && !topo) loadTopo();
  }, [view]);

  const appAction = async (action: string, appId: number, body?: Record<string, unknown>) => {
    const key = `${action}-${appId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/apps/${appId}`) as { op_id?: number }
        : action === "redeploy"
          ? (() => {
            const app = data.apps.find((a) => a.id === appId);
            if (!app) throw new Error("App not found");
            return post(`/api/apps/deploy`, {
              app_name: app.name,
              git_repo: app.git_repo,
              container_port: app.container_port,
            }) as { op_id?: number };
          })()
          : await post(`/api/apps/${appId}/${action}`, body) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, APP_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const svcAction = async (action: string, svcId: number) => {
    const key = `svc-${action}-${svcId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/services/${svcId}`) as { op_id?: number }
        : await post(`/api/services/${svcId}/${action}`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, SVC_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const stackRedeploy = async (stack: StackData) => {
    const key = `stack-redeploy-${stack.id}`;
    setActionLoading(key);
    try {
      const res = await post(`/api/stacks/${stack.id}/redeploy`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, `Redeploying stack ${stack.name}`);
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  // Bulk promote: every member with a webhook-staging sibling holding a deployed
  // commit moves to production. Members are promoted concurrently — stack
  // dependency edges are not persisted, so there is no order to respect.
  const stackPromote = async (stack: StackData) => {
    const n = stack.staging_sibling_count ?? 0;
    if (!(await confirm(
      "Promote Staging",
      `Promote the staging sibling of ${n} member(s) of "${stack.name}" to production? Each member is rebuilt from the commit its staging app is running. Members are promoted concurrently, not in dependency order.`,
    ))) return;
    const key = `stack-promote-${stack.id}`;
    setActionLoading(key);
    try {
      const res = await post(`/api/stacks/${stack.id}/promote`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, `Promoting stack ${stack.name}`);
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const stackDestroy = async (stack: StackData) => {
    if (!(await confirm(
      "Destroy Stack",
      `Permanently destroy "${stack.name}" and all ${stack.app_count} app(s) and ${stack.service_count} service(s)? Containers and routing are removed; environments are retained, and managed volumes are detached for recovery.`,
      true,
    ))) return;
    const key = `stack-delete-${stack.id}`;
    setActionLoading(key);
    try {
      const res = await serverConfirmedDelete<{ op_id?: number }>(
        `/api/stacks/${stack.id}`,
        "delete_stack",
        "stack",
        stack.id,
      );
      if (res?.op_id) {
        trackOperationInToast(res.op_id, `Destroying stack ${stack.name}`);
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const appBusyKind = (appId: number) => ops.byResourceKey(`app:${appId}`)?.kind;
  const svcBusyKind = (svcId: number) => ops.byResourceKey(`service:${svcId}`)?.kind;
  const stackBusyKind = (stackId: number) => ops.byResourceKey(`stack:${stackId}`)?.kind;

  const isAppActionLoading = (appId: number, action: string) => {
    const k = `${action}-${appId}`;
    return actionLoading === k || appBusyKind(appId) === APP_ACTION_TO_KIND[action];
  };
  const isSvcActionLoading = (svcId: number, action: string) => {
    const k = `svc-${action}-${svcId}`;
    return actionLoading === k || svcBusyKind(svcId) === SVC_ACTION_TO_KIND[action];
  };

  const toggleStack = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // --- Row renderers (shared between top-level and stack-nested placement) ---

  const renderAppRow = (app: AppData, opts?: { nested?: boolean; last?: boolean }) => {
    const nested = opts?.nested ?? false;
    const rowBusy = !!appBusyKind(app.id);
    // Scope disabling to this app's own in-flight op — the engine serializes per
    // `app:${id}`, so another app being busy is irrelevant here.
    const disableRow = rowBusy;
    return (
      <div key={`app-${app.id}`} className={nested ? "relative" : ""}>
        {nested && (
          <>
            <span aria-hidden className={`absolute left-[23px] top-0 ${opts?.last ? "h-1/2" : "bottom-0"} w-[1.5px] bg-fg/10`} />
            <span aria-hidden className="absolute left-[23px] top-1/2 h-[1.5px] w-[11px] bg-fg/10" />
          </>
        )}
        <div className={`${nested ? "pl-10 pr-4" : "px-4"} py-3 flex items-center justify-between hover:bg-alt/50 transition-colors ${app.status === "paused" ? "opacity-50" : ""} ${rowBusy ? "bg-alt/30" : ""}`}>
          <div className="flex items-center gap-4 min-w-0">
            <a href={`#/apps/${app.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{app.name}</a>
            {app.domain && (
              <span className="flex items-center gap-1 text-[9px] font-mono text-muted">
                <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="flex items-center gap-1 hover:text-fg transition-colors">
                  <Globe size={10} />{app.domain}<ExternalLink size={8} />
                </a>
                <CopyButton text={`https://${app.domain}`} size={10} />
              </span>
            )}
            {!app.public && !app.domain && (
              <span className="flex items-center gap-1 text-[9px] font-mono text-muted">
                <Globe size={10} />{app.internal_protocol === "tcp" ? `${app.name}.ocd.internal:${app.container_port}` : `${app.name}.ocd.internal`}
                <CopyButton text={app.internal_protocol === "tcp" ? `tcp://${app.name}.ocd.internal:${app.container_port}` : `http://${app.name}.ocd.internal`} size={10} />
                <span className="font-mono text-[8px] font-bold border border-fg px-1 uppercase">Private</span>
              </span>
            )}
            <StatusBadge
              status={app.status}
              subLabel={app.environment_stale ? "stale environment — redeploy required" : undefined}
            />
            {app.webhook_enabled ? <span title="Webhook active"><GitBranch size={10} className="text-accent" /></span> : null}
            {app.desired_replicas > 1 && (
              <span className="font-mono text-[9px] font-bold border border-fg px-1">{app.desired_replicas}x</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <PermissionGate permission="apps.logs" appId={app.id} environmentId={app.environment_id}>
              <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/apps/${app.id}`; }}><ScrollText size={12} /></Btn>
            </PermissionGate>
            <PermissionGate permission="apps.restart" appId={app.id} environmentId={app.environment_id}>
              {(() => {
                const k = `restart-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "restart")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("restart", app.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <RotateCcw size={12} />}
                  </Btn>
                );
              })()}
            </PermissionGate>
            <PermissionGate permission="apps.pause" appId={app.id} environmentId={app.environment_id}>
              {app.status === "paused" ? (() => {
                const k = `unpause-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "unpause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("unpause", app.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                  </Btn>
                );
              })() : (() => {
                const k = `pause-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "pause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("pause", app.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <Pause size={12} />}
                  </Btn>
                );
              })()}
            </PermissionGate>
            <PermissionGate permission="apps.deploy" appId={app.id} environmentId={app.environment_id}>
              {(() => {
                const k = `redeploy-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isAppActionLoading(app.id, "redeploy")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("redeploy", app.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <RefreshCw size={12} />}
                  </Btn>
                );
              })()}
            </PermissionGate>
            <PermissionGate permission="apps.destroy" appId={app.id} environmentId={app.environment_id}>
              <Btn
                size="xs"
                variant="ghost"
                loading={isAppActionLoading(app.id, "delete")}
                disabled={disableRow}
                onClick={async () => {
                  if (await confirm("Destroy App", `Permanently destroy "${app.name}"? This removes all containers, DNS records, and webhooks.`, true)) {
                    appAction("delete", app.id);
                  }
                }}
              ><Trash2 size={12} className="text-accent-red" /></Btn>
            </PermissionGate>
          </div>
        </div>
      </div>
    );
  };

  const renderServiceRow = (svc: ServiceData, opts?: { nested?: boolean; last?: boolean }) => {
    const nested = opts?.nested ?? false;
    const rowBusy = !!svcBusyKind(svc.id);
    // Scope disabling to this service's own in-flight op (engine serializes per
    // `service:${id}`).
    const disableRow = rowBusy;
    return (
      <div key={`svc-${svc.id}`} className={nested ? "relative" : ""}>
        {nested && (
          <>
            <span aria-hidden className={`absolute left-[23px] top-0 ${opts?.last ? "h-1/2" : "bottom-0"} w-[1.5px] bg-fg/10`} />
            <span aria-hidden className="absolute left-[23px] top-1/2 h-[1.5px] w-[11px] bg-fg/10" />
          </>
        )}
        <div className={`${nested ? "pl-10 pr-4" : "px-4"} py-3 flex items-center justify-between hover:bg-alt/50 transition-colors ${svc.status === "paused" ? "opacity-50" : ""} ${rowBusy ? "bg-alt/30" : ""}`}>
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex items-center gap-1.5">
              <Database size={10} className="text-muted" />
              <a href={`#/services/${svc.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{svc.name}</a>
            </div>
            <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{svc.service_type}</span>
            <span className="font-mono text-[9px] text-muted">{svc.version}</span>
            <StatusBadge status={svc.status} />
            {svc.linked_environments.length > 0 && (
              <span className="font-mono text-[8px] text-muted">
                injected into {svc.linked_environments.map((e) => e.name).join(", ")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <PermissionGate permission="services.logs">
              <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/services/${svc.id}`; }}><ScrollText size={12} /></Btn>
            </PermissionGate>
            <PermissionGate permission="services.manage">
              {(() => {
                const k = `svc-restart-${svc.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "restart")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("restart", svc.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <RotateCcw size={12} />}
                  </Btn>
                );
              })()}
            </PermissionGate>
            <PermissionGate permission="services.manage">
              {svc.status === "paused" ? (() => {
                const k = `svc-unpause-${svc.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "unpause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("unpause", svc.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <Play size={12} />}
                  </Btn>
                );
              })() : (() => {
                const k = `svc-pause-${svc.id}`;
                const armed = confirmKey === k;
                return (
                  <Btn size="xs" variant="ghost" loading={isSvcActionLoading(svc.id, "pause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => svcAction("pause", svc.id))}>
                    {armed ? <Check size={12} className="text-accent-blue" /> : <Pause size={12} />}
                  </Btn>
                );
              })()}
            </PermissionGate>
            <PermissionGate permission="services.destroy">
              <Btn
                size="xs"
                variant="ghost"
                loading={isSvcActionLoading(svc.id, "delete")}
                disabled={disableRow}
                onClick={async () => {
                  if (await confirm("Destroy Service", `Permanently destroy "${svc.name}"? This removes all containers, volumes, and data.`, true)) {
                    svcAction("delete", svc.id);
                  }
                }}
              ><Trash2 size={12} className="text-accent-red" /></Btn>
            </PermissionGate>
          </div>
        </div>
      </div>
    );
  };

  const renderStackGroup = (stack: StackData, members: { apps: AppData[]; services: ServiceData[] }) => {
    const isOpen = expanded.has(stack.id);
    const memberApps = members.apps;
    const memberSvcs = members.services;
    const memberBusy =
      memberApps.some((a) => !!appBusyKind(a.id)) || memberSvcs.some((s) => !!svcBusyKind(s.id));
    const stackKind = stackBusyKind(stack.id);
    const busy = !!stackKind || memberBusy;
    const redeploying =
      actionLoading === `stack-redeploy-${stack.id}` ||
      stackKind === "cascade_redeploy" ||
      memberApps.some((a) => appBusyKind(a.id) === "redeploy");
    const promoting =
      actionLoading === `stack-promote-${stack.id}` || stackKind === "promote_stack";
    const stagingSiblings = stack.staging_sibling_count ?? 0;
    const destroying =
      actionLoading === `stack-delete-${stack.id}` || stackKind === "destroy_stack";
    const total = memberApps.length + memberSvcs.length;

    return (
      <div key={`stack-${stack.id}`} className={busy ? "bg-alt/30" : ""}>
        <div
          className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors cursor-pointer bg-alt/20"
          onClick={() => toggleStack(stack.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isOpen
              ? <ChevronDown size={12} className="text-muted flex-shrink-0" />
              : <ChevronRight size={12} className="text-muted flex-shrink-0" />}
            <Boxes size={13} className="text-fg flex-shrink-0" />
            <a
              href={`#/stacks/${stack.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[10px] font-bold text-fg uppercase hover:underline"
            >{stack.name}</a>
            <StatusBadge status={stack.status} />
            <span className="font-mono text-[9px] text-muted flex items-center gap-1">
              <Box size={9} /> {memberApps.length}
            </span>
            <span className="font-mono text-[9px] text-muted flex items-center gap-1">
              <Database size={9} /> {memberSvcs.length}
            </span>
          </div>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <span className="font-mono text-[9px] text-muted hidden sm:inline">
              {new Date(stack.created_at.replace(" ", "T") + "Z").toLocaleDateString()}
            </span>
            <PermissionGate permission="stacks.deploy" environmentId={stack.environment_id}>
              <Btn size="xs" variant="ghost" title="Redeploy stack" loading={redeploying} disabled={busy} onClick={() => stackRedeploy(stack)}>
                <RefreshCw size={12} />
              </Btn>
            </PermissionGate>
            {/* Only shown when there is something to promote — a stack with no
                staging siblings has no use for the button at all. */}
            {stagingSiblings > 0 && (
            <PermissionGate permission="stacks.promote" environmentId={stack.environment_id}>
              <Btn
                size="xs"
                variant="ghost"
                title={`Promote staging → production for ${stagingSiblings} member(s)`}
                loading={promoting}
                disabled={busy}
                onClick={() => stackPromote(stack)}
              >
                <ArrowUpFromLine size={12} />
              </Btn>
            </PermissionGate>
            )}
            <PermissionGate permission="stacks.destroy" environmentId={stack.environment_id}>
              <Btn size="xs" variant="ghost" title="Destroy stack" loading={destroying} disabled={busy} onClick={() => stackDestroy(stack)}>
                <Trash2 size={12} className="text-accent-red" />
              </Btn>
            </PermissionGate>
          </div>
        </div>

        {isOpen && total > 0 && (
          <div className="divide-y divide-fg/10 border-t border-fg/10">
            {memberSvcs.map((svc, i) =>
              renderServiceRow(svc, { nested: true, last: memberApps.length === 0 && i === memberSvcs.length - 1 }))}
            {memberApps.map((app, i) =>
              renderAppRow(app, { nested: true, last: i === memberApps.length - 1 }))}
          </div>
        )}
        {isOpen && total === 0 && (
          <div className="pl-10 pr-4 py-3 font-mono text-[9px] text-muted border-t border-fg/10">No members</div>
        )}
      </div>
    );
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  const { apps, services } = data;

  // Split standalone resources from stack members; members render nested under
  // their stack, so they must not also appear as loose top-level rows.
  const standaloneApps = apps.filter((a) => a.stack_id == null);
  const standaloneServices = services.filter((s) => s.stack_id == null);
  const appsByStack = new Map<number, AppData[]>();
  const svcsByStack = new Map<number, ServiceData[]>();
  for (const a of apps) {
    if (a.stack_id != null) appsByStack.set(a.stack_id, [...(appsByStack.get(a.stack_id) ?? []), a]);
  }
  for (const s of services) {
    if (s.stack_id != null) svcsByStack.set(s.stack_id, [...(svcsByStack.get(s.stack_id) ?? []), s]);
  }

  const nothingDeployed = apps.length === 0 && services.length === 0 && stacks.length === 0;
  const showAppsCard = standaloneApps.length > 0 || stacks.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Dashboard</h1>
          <p className="text-[10px] text-muted font-mono mt-0.5">
            {apps.length} app{apps.length !== 1 ? "s" : ""}
            {services.length > 0 && `, ${services.length} service${services.length !== 1 ? "s" : ""}`}
            {stacks.length > 0 && `, ${stacks.length} stack${stacks.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {/* View switch: table list vs. topology graph */}
          <div className="flex border-2 border-fg shadow-neo-sm">
            <button
              onClick={() => setView("table")}
              title="List view"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors ${view === "table" ? "bg-fg text-accent" : "bg-bg-raised text-fg-dim hover:bg-alt"}`}
            ><Table2 size={12} /> List</button>
            <button
              onClick={() => setView("graph")}
              title="Topology graph"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider border-l-2 border-fg transition-colors ${view === "graph" ? "bg-fg text-accent" : "bg-bg-raised text-fg-dim hover:bg-alt"}`}
            ><Share2 size={12} /> Graph</button>
          </div>
          <Btn onClick={() => { load(); if (view === "graph") loadTopo(); }} variant="ghost"><RefreshCw size={13} /> Refresh</Btn>
        </div>
      </div>

      {view === "graph" ? (
        topoLoading && !topo
          ? <div className="flex justify-center py-20"><Spinner /></div>
          : topo
            ? <TopologyGraph data={topo} />
            : <EmptyState message="No topology data yet." icon={Share2} />
      ) : (
      <>
      {nothingDeployed ? (
        <EmptyState message="Nothing deployed yet. Deploy your first app or service to get started." icon={Box} />
      ) : (
        <>
          {/* Apps + stacks */}
          {showAppsCard && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b-2 border-fg flex items-center gap-2 bg-alt">
                <Box size={14} className="text-fg" />
                <span className="font-mono text-[10px] font-bold text-fg uppercase">Apps</span>
              </div>
              <div className="divide-y divide-fg/10">
                {standaloneApps.map((app) => renderAppRow(app))}
                {stacks.map((stack) => renderStackGroup(stack, {
                  apps: appsByStack.get(stack.id) ?? [],
                  services: svcsByStack.get(stack.id) ?? [],
                }))}
              </div>
            </Card>
          )}

          {/* Standalone services */}
          {standaloneServices.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b-2 border-fg flex items-center gap-2 bg-alt">
                <Database size={14} className="text-fg" />
                <span className="font-mono text-[10px] font-bold text-fg uppercase">Services</span>
              </div>
              <div className="divide-y divide-fg/10">
                {standaloneServices.map((svc) => renderServiceRow(svc))}
              </div>
            </Card>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}
