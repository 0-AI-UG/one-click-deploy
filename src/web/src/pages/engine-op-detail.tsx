import { ArrowLeft, ScrollText } from "lucide-react";
import { useOperation, cancelOperation, humanizeStep, TERMINAL_STATUSES } from "../hooks/useOperation.ts";
import { Spinner, confirm, Btn } from "../components/ui.tsx";

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

  if (!op) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const active = !TERMINAL_STATUSES.has(op.status);
  const forward = (op.steps || []).filter((s) => s.phase === "forward");
  const compensations = (op.steps || []).filter((s) => s.phase === "compensate");

  async function onCancel() {
    const ok = await confirm("Cancel operation?", "The engine will stop at the next step boundary and run compensations.", true);
    if (!ok) return;
    await cancelOperation(opId);
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
      <div className="mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/engine"; }}><ArrowLeft size={14} /></Btn>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-xl font-bold uppercase tracking-wider">{op.kind}</h1>
            <span className="font-mono text-sm text-fg-dim">#{op.id}</span>
            <span
              className={`font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-1 border-2 border-fg ${
                op.status === "done"
                  ? "bg-accent text-fg"
                  : op.status === "running"
                    ? "bg-accent-blue text-white"
                    : op.status === "failed" || op.status === "compensated"
                      ? "bg-accent-red text-white"
                      : op.status === "compensating"
                        ? "bg-accent-amber text-fg"
                        : "bg-alt text-fg"
              }`}
            >
              {op.status}
            </span>
          </div>
          <div className="mt-2 text-xs text-fg-dim font-mono">
            {(op.resource_labels ?? op.resource_keys).join(", ")} · triggered by {op.trigger}
            {op.attempt > 1 && ` · attempt ${op.attempt}`}
          </div>
        </div>
        {active && (
          <button
            onClick={onCancel}
            className="font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg bg-accent-red text-white px-3 py-1.5 shadow-neo-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none transition-all"
          >
            Cancel
          </button>
        )}
      </div>

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
        <h2 className="font-mono text-sm font-bold uppercase tracking-wider mb-3">Steps</h2>
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
          <h2 className="font-mono text-sm font-bold uppercase tracking-wider mb-3">
            Child Operations ({op.children.length})
          </h2>
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
          <h2 className="font-mono text-sm font-bold uppercase tracking-wider mb-3 text-accent-red">
            Compensations
          </h2>
          <div className="flex flex-col gap-1">
            {compensations.map((s) => (
              <StepRow key={s.seq} step={s} />
            ))}
          </div>
        </section>
      )}
    </div>
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
