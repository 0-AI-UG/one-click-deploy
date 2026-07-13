import { useState, useEffect } from "react";
import { get, del } from "../api/client.ts";
import { Card, StatusBadge, Btn, EmptyState, Spinner, showToast, confirm } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { Boxes, Box, Database, ChevronDown, ChevronRight, Trash2, ScrollText, Globe } from "lucide-react";
import type { Stack, StackDetail } from "../types.ts";

const STACK_OP_KINDS = new Set(["deploy_stack", "destroy_stack"]);

export function StacksPage() {
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<StackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const ops = useActiveOperations(
    (op) => STACK_OP_KINDS.has(op.kind),
    { rehydrateToasts: true },
  );

  const load = () => {
    get("/api/stacks")
      .then(setStacks)
      .catch((err: any) => showToast(err.message, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Refetch when the set of active stack ops changes (enqueue + terminal).
  const activeSig = ops.active.map((o) => `${o.id}:${o.status}`).join(",");
  useEffect(() => {
    if (!loading) load();
  }, [activeSig]);

  const toggle = (stack: Stack) => {
    if (expanded === stack.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(stack.id);
    setDetail(null);
    setDetailLoading(true);
    get(`/api/stacks/${stack.id}`)
      .then((d: StackDetail) => setDetail(d))
      .catch((err: any) => showToast(err.message, "error"))
      .finally(() => setDetailLoading(false));
  };

  const destroy = async (stack: Stack) => {
    if (!(await confirm(
      "Destroy Stack",
      `Permanently destroy "${stack.name}" and all ${stack.app_count} app(s) and ${stack.service_count} service(s)? This removes every member's containers, volumes, and data.`,
      true,
    ))) return;
    try {
      const res = await del(`/api/stacks/${stack.id}`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, `Destroying stack ${stack.name}`);
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const stackBusy = (id: number) => !!ops.byResourceKey(`stack:${id}`);

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Stacks</h1>
          <p className="text-[10px] text-muted font-mono mt-0.5">
            {stacks.length} stack{stacks.length !== 1 ? "s" : ""}
          </p>
        </div>
        <PermissionGate permission="stacks.deploy">
          <Btn size="sm" variant="primary" onClick={() => { window.location.hash = "#/deploy/stack"; }}>
            <Boxes size={12} /> New stack
          </Btn>
        </PermissionGate>
      </div>

      {stacks.length === 0 ? (
        <EmptyState message="No stacks yet. Deploy one from the Deploy page, or with `ocd stack up`." icon={Boxes} />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-fg/10">
            {stacks.map((stack) => {
              const isOpen = expanded === stack.id;
              const busy = stackBusy(stack.id);
              return (
                <div key={stack.id} className={busy ? "bg-alt/30" : ""}>
                  <div
                    className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors cursor-pointer"
                    onClick={() => toggle(stack)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isOpen
                        ? <ChevronDown size={12} className="text-muted flex-shrink-0" />
                        : <ChevronRight size={12} className="text-muted flex-shrink-0" />}
                      <Boxes size={12} className="text-muted flex-shrink-0" />
                      <span className="font-mono text-[10px] font-bold text-fg uppercase">{stack.name}</span>
                      <StatusBadge status={stack.status} />
                      <span className="font-mono text-[9px] text-muted flex items-center gap-1">
                        <Box size={9} /> {stack.app_count}
                      </span>
                      <span className="font-mono text-[9px] text-muted flex items-center gap-1">
                        <Database size={9} /> {stack.service_count}
                      </span>
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <span className="font-mono text-[9px] text-muted hidden sm:inline">
                        {new Date(stack.created_at.replace(" ", "T") + "Z").toLocaleDateString()}
                      </span>
                      <PermissionGate permission="stacks.destroy">
                        <Btn
                          size="xs"
                          variant="ghost"
                          title="Destroy stack"
                          disabled={busy}
                          onClick={() => destroy(stack)}
                        >
                          <Trash2 size={12} className="text-accent-red" />
                        </Btn>
                      </PermissionGate>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 ml-7 space-y-3">
                      {detailLoading || !detail ? (
                        <div className="py-4"><Spinner /></div>
                      ) : (
                        <>
                          {/* Members */}
                          {detail.services.length > 0 && (
                            <div>
                              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1.5">Services</div>
                              <div className="space-y-1.5">
                                {detail.services.map((svc) => (
                                  <div key={svc.id} className="flex items-center gap-3 flex-wrap">
                                    <Database size={10} className="text-muted flex-shrink-0" />
                                    <a href={`#/services/${svc.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{svc.name}</a>
                                    <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{svc.service_type}</span>
                                    {svc.version && <span className="font-mono text-[9px] text-muted">{svc.version}</span>}
                                    <StatusBadge status={svc.status} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {detail.apps.length > 0 && (
                            <div>
                              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1.5">Apps</div>
                              <div className="space-y-1.5">
                                {detail.apps.map((app) => (
                                  <div key={app.id} className="flex items-center gap-3 flex-wrap">
                                    <Box size={10} className="text-muted flex-shrink-0" />
                                    <a href={`#/apps/${app.id}`} className="font-mono text-[10px] font-bold text-accent-blue hover:underline uppercase">{app.name}</a>
                                    {app.domain && (
                                      <span className="flex items-center gap-1 text-[9px] font-mono text-muted">
                                        <Globe size={10} />{app.domain}
                                      </span>
                                    )}
                                    <StatusBadge status={app.status} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {detail.apps.length === 0 && detail.services.length === 0 && (
                            <div className="font-mono text-[9px] text-muted">No members</div>
                          )}

                          {/* Combined deploy log */}
                          {detail.deploy_log?.trim() && (
                            <div>
                              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
                                <ScrollText size={10} /> Deploy log
                              </div>
                              <pre className="font-mono text-[9px] text-fg-dim bg-alt/40 border-2 border-fg/10 p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                                {detail.deploy_log.trim()}
                              </pre>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
