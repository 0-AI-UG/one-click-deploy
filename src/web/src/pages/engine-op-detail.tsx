import { useState } from "react";
import { RefreshCw, ScrollText, Wrench } from "lucide-react";
import { useOperation, humanizeStep, TERMINAL_STATUSES } from "../hooks/useOperation.ts";
import { confirm, Btn, showToast, Badge, PageShell, PageHeader, PageState, SectionHeader } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts.replace(" ", "T") + "Z").toLocaleTimeString();
}

function stepStatusClass(status: string): string {
  if (status === "ok") return "bg-accent text-fg";
  if (status === "started") return "bg-accent-blue text-white";
  if (status === "failed") return "bg-accent-red text-white";
  if (status === "skipped") return "bg-alt text-fg-dim";
  return "bg-alt text-fg";
}

export function EngineOpDetailPage({ opId }: { opId: number }) {
  const op = useOperation(opId);
  const [actionBusy, setActionBusy] = useState<"cancel" | "retry" | "finalize" | null>(null);

  if (!op) {
    return <PageState title="Loading operation" />;
  }

  const active = !TERMINAL_STATUSES.has(op.status);
  const forward = (op.steps || []).filter((s) => s.phase === "forward");
  const compensations = (op.steps || []).filter((s) => s.phase === "compensate");

  async function onCancel() {
    const ok = await confirm("Cancel operation?", "The engine will stop at the next step boundary and run compensations.", true);
    if (!ok) return;
    setActionBusy("cancel");
    try {
      await runConfirmedCliAction(
        "ops.cancel",
        { operation: String(opId) },
        { action: "cancel_operation", resourceType: "operation", resourceId: opId },
      );
      showToast("Cancellation requested", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Cancellation failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function onRetry() {
    if (!await confirm("Retry operation?", "Resume cleanup when possible, otherwise create a fresh retry.")) return;
    setActionBusy("retry");
    try {
      await runCliAction("ops.retry", { operation: String(opId) }, { confirmed: true });
      showToast("Operation retried", "success");
      window.location.hash = "#/engine";
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Retry failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function onFinalize() {
    if (!await confirm("Finalize operation?", "Reconcile the affected resources and close this stale operation using the engine's automatic assessment.", true)) return;
    setActionBusy("finalize");
    try {
      await runCliAction("ops.finalize", { operation: String(opId), status: "auto" }, { confirmed: true });
      showToast("Operation finalized", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Finalize failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        backHref="#/engine"
        backLabel="Back to operations"
        eyebrow={`Operation #${op.id}`}
        title={op.kind}
        meta={<>
          <Badge tone={op.status === "done" ? "success" : op.status === "running" ? "info" : op.status.includes("fail") || op.status === "compensated" ? "danger" : op.status === "compensating" ? "warning" : "neutral"}>{op.status}</Badge>
          <div className="mt-2">
            {(op.resource_labels ?? op.resource_keys).join(", ")} · triggered by {op.trigger}
            {op.attempt > 1 && ` · attempt ${op.attempt}`}
          </div>
        </>}
        actions={<>
        {active && (
          <PermissionGate permission="operations.cancel">
          <Btn
            variant="danger"
            onClick={onCancel}
            loading={actionBusy === "cancel"}
            disabled={actionBusy !== null}
          >
            Cancel
          </Btn>
          </PermissionGate>
        )}
        {["failed", "compensation_failed", "compensated", "cancelled"].includes(op.status) && (
          <PermissionGate permission="operations.cancel">
            <Btn size="xs" loading={actionBusy === "retry"} disabled={actionBusy !== null} onClick={onRetry}>
              <RefreshCw size={12} /> Retry
            </Btn>
          </PermissionGate>
        )}
        {["failed", "compensation_failed"].includes(op.status) && (
          <PermissionGate permission="operations.cancel">
            <Btn size="xs" variant="ghost" loading={actionBusy === "finalize"} disabled={actionBusy !== null} onClick={onFinalize}>
              <Wrench size={12} /> Finalize
            </Btn>
          </PermissionGate>
        )}
        </>}
      />

      <div className="grid grid-cols-3 gap-3 mb-6 text-[10px] font-mono">
        <Meta label="Enqueued" value={fmtTs(op.enqueued_at)} />
        <Meta label="Started" value={fmtTs(op.started_at)} />
        <Meta label="Finished" value={fmtTs(op.finished_at)} />
      </div>

      <div className="mb-4">
        <a
          href={`#/engine/op/${op.id}/logs`}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg bg-bg-raised text-fg px-3 py-1.5 shadow-neo-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none transition-all"
        >
          <ScrollText size={12} /> View Logs
        </a>
      </div>

      <section className="mb-6">
        <SectionHeader className="mb-3" title="Steps" />
        <div className="flex flex-col gap-1">
          {forward.map((s) => (
            <StepRow key={s.seq} step={s} />
          ))}
          {forward.length === 0 && (
            <div className="text-xs font-mono text-fg-dim">No steps yet.</div>
          )}
        </div>
      </section>

      {op.children && op.children.length > 0 && (
        <section className="mb-6">
          <SectionHeader className="mb-3" title={`Child operations (${op.children.length})`} />
          <div className="flex flex-col gap-1">
            {op.children.map((c) => (
              <a
                key={c.id}
                href={`#/engine/op/${c.id}`}
                className="border-2 border-fg bg-bg-raised shadow-neo-sm px-3 py-2 flex items-center gap-2 hover:bg-alt transition-colors"
              >
                <span className="font-mono text-[9px] text-fg-dim">#{c.id}</span>
                <span className={`font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-2 border-fg ${
                  c.status === "done" ? "bg-accent text-fg"
                    : c.status === "running" ? "bg-accent-blue text-white"
                    : c.status === "compensation_failed" ? "bg-accent-red text-white border-dashed"
                    : c.status === "failed" || c.status === "compensated" ? "bg-accent-red text-white"
                    : "bg-alt text-fg"
                }`}>{c.status}</span>
                <span className="font-mono text-xs font-bold">{c.kind}</span>
                <span className="font-mono text-[10px] text-fg-dim ml-auto">{(c.resource_labels ?? c.resource_keys).join(", ")}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {compensations.length > 0 && (
        <section>
          <SectionHeader className="mb-3" title="Compensations" />
          <div className="flex flex-col gap-1">
            {compensations.map((s) => (
              <StepRow key={s.seq} step={s} />
            ))}
          </div>
        </section>
      )}
    </PageShell>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-fg bg-bg-raised shadow-neo-sm p-2">
      <div className="text-[9px] font-bold uppercase tracking-wider text-fg-dim">{label}</div>
      <div className="mt-0.5 text-fg">{value}</div>
    </div>
  );
}


function StepRow({ step }: { step: NonNullable<ReturnType<typeof useOperation>>["steps"] extends (infer T)[] | undefined ? T : never }) {
  return (
    <div className="border-2 border-fg bg-bg-raised shadow-neo-sm px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] text-fg-dim">#{step.seq}</span>
        <span
          className={`font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-2 border-fg ${stepStatusClass(step.status)}`}
        >
          {step.status}
        </span>
        <span className="font-mono text-xs font-bold">{humanizeStep(step.step)}</span>
        <span className="font-mono text-[10px] text-fg-dim ml-auto">
          {fmtTs(step.started_at)}
          {step.finished_at ? ` → ${fmtTs(step.finished_at)}` : ""}
        </span>
      </div>
      {step.detail && (
        <div className="mt-1 font-mono text-[10px] text-fg-dim">{step.detail}</div>
      )}
    </div>
  );
}
