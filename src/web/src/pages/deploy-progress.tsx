import { useEffect, useRef } from "react";
import { Btn } from "../components/ui.tsx";
import {
  Rocket, Check, X, Loader2, ChevronRight, Terminal, ArrowLeft, CheckCircle2, XCircle,
} from "lucide-react";
import { useOperation, humanizeStep, collapseForwardSteps, TERMINAL_STATUSES } from "../hooks/useOperation.ts";
import type { OperationStep } from "../hooks/useOperation.ts";

function StepBadge({ status }: { status: OperationStep["status"] }) {
  const isOk = status === "ok" || status === "skipped";
  const isActive = status === "started";
  const isFailed = status === "failed";
  if (isOk)
    return (
      <span className="w-6 h-6 shrink-0 border-2 border-fg bg-accent-green flex items-center justify-center">
        <Check size={13} strokeWidth={3} className="text-fg" />
      </span>
    );
  if (isActive)
    return (
      <span className="w-6 h-6 shrink-0 border-2 border-fg bg-accent-amber flex items-center justify-center">
        <Loader2 size={13} className="animate-spin text-fg" />
      </span>
    );
  if (isFailed)
    return (
      <span className="w-6 h-6 shrink-0 border-2 border-fg bg-accent-red flex items-center justify-center">
        <X size={13} strokeWidth={3} className="text-fg" />
      </span>
    );
  return (
    <span className="w-6 h-6 shrink-0 border-2 border-fg/30 flex items-center justify-center">
      <span className="w-1.5 h-1.5 rounded-full bg-muted" />
    </span>
  );
}

export function DeployProgressPage({ opId }: { opId: number | null }) {
  const op = useOperation(opId);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!opId) window.location.hash = "#/deploy";
  }, [opId]);

  const steps: OperationStep[] = op?.steps || [];

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [steps.length]);

  const status = op?.status ?? "pending";
  const terminal = TERMINAL_STATUSES.has(status);
  const succeeded = status === "done";
  const failed = terminal && !succeeded;
  const errorMessage = op?.error?.message ?? null;
  const appName = (op as any)?.input?.app_name ?? "";
  const domain = (op as any)?.input?.domain ?? "";

  // Redirect to app detail on success. We need an appId — pull it from the
  // insert_app_row step output.
  useEffect(() => {
    if (!succeeded) return;
    const insertStep = steps.find((s) => s.step === "insert_app_row" && s.status === "ok");
    const appId = insertStep?.output && typeof insertStep.output === "object"
      ? (insertStep.output as { appId?: number }).appId
      : undefined;
    const t = setTimeout(() => {
      window.location.hash = appId ? `#/apps/${appId}` : "#/";
    }, 1200);
    return () => clearTimeout(t);
  }, [succeeded, steps.length]);

  const collapsed = collapseForwardSteps(steps);
  const completedCount = collapsed.filter((s) => s.status === "ok" || s.status === "skipped").length;
  const totalSteps = Math.max(op?.total_steps ?? 0, collapsed.length, completedCount);
  const pct = succeeded ? 100 : totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 8;

  const lastForward = [...steps].reverse().find((s) => s.phase === "forward");
  const currentLine = succeeded
    ? domain ? `Live at https://${domain}` : "Deploy complete"
    : failed
      ? errorMessage || `Deploy ${status}`
      : lastForward
        ? `${humanizeStep(lastForward.step)}${lastForward.detail ? ` — ${lastForward.detail}` : ""}`
        : status === "pending" ? "Added to queue" : "Starting";

  const pill = succeeded
    ? { text: "Live", dot: "bg-accent-green", headerBg: "bg-accent" }
    : failed
      ? { text: "Failed", dot: "bg-accent-red", headerBg: "bg-accent-red" }
      : status === "running" || status === "compensating"
        ? { text: status === "compensating" ? "Rolling back" : "Running", dot: "bg-accent-amber animate-pulse", headerBg: "bg-accent-amber" }
        : status === "pending"
          ? { text: "Queued", dot: "bg-muted", headerBg: "bg-alt" }
          : { text: "Idle", dot: "bg-muted", headerBg: "bg-alt" };

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
      {/* Timeline + collapsed log */}
      <div className="border-2 border-fg bg-bg-raised shadow-neo-sm">
        {steps.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-4">
            <Loader2 size={16} className="animate-spin text-fg" />
            <span className="font-mono text-[11px] uppercase tracking-wider font-bold text-fg">
              {status === "pending" ? "Added to queue" : "Starting"}
            </span>
          </div>
        ) : (
          <ol>
            {collapsed.map((s, i) => {
              const isActive = s.status === "started";
              const isPending = !isActive && s.status !== "ok" && s.status !== "skipped" && s.status !== "failed";
              return (
                <li
                  key={s.seq}
                  className={`flex items-center gap-3 px-4 py-3 ${
                    i < collapsed.length - 1 ? "border-b border-fg/10" : ""
                  } ${isActive ? "bg-accent-amber/15" : ""} ${isPending ? "opacity-55" : ""}`}
                >
                  <StepBadge status={s.status} />
                  <span className={`font-mono text-[12px] flex-1 truncate ${isActive ? "font-bold text-fg" : "text-fg"}`}>
                    {humanizeStep(s.step)}
                  </span>
                  {s.detail && (
                    <span className="font-mono text-[9px] text-muted truncate max-w-[45%]">
                      {s.detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <details className="border-t-2 border-fg group">
          <summary className="px-4 py-2.5 cursor-pointer list-none hover:bg-alt flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-muted">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            <Terminal size={11} /> Show live log
          </summary>
          <div
            ref={logRef}
            className="bg-fg text-bg p-3 h-56 overflow-y-auto font-mono text-[10px] leading-relaxed"
          >
            {steps.length === 0 && !terminal && (
              <div className="flex items-center gap-2 text-accent-amber">
                <Loader2 size={12} className="animate-spin" />
                <span>awaiting first event</span>
              </div>
            )}
            {steps.map((ev) => {
              const isCompensate = ev.phase === "compensate";
              const isFailed = ev.status === "failed";
              return (
                <div
                  key={ev.seq}
                  className={`flex gap-2 ${isFailed ? "text-accent-red" : isCompensate ? "text-accent-amber" : "text-bg"}`}
                >
                  <span className="text-accent-amber shrink-0">›</span>
                  <span className="text-muted shrink-0 w-56 uppercase truncate">
                    [{isCompensate ? "undo:" : ""}{ev.step}]
                  </span>
                  <span className="whitespace-pre-wrap break-all">
                    {ev.status}
                    {ev.detail ? ` — ${ev.detail}` : ""}
                  </span>
                </div>
              );
            })}
            {terminal && (
              <div
                className={`flex items-center gap-2 mt-3 pt-2 border-t-2 border-bg ${
                  succeeded ? "text-accent-green" : "text-accent-red"
                }`}
              >
                {succeeded ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span className="font-bold">
                  {succeeded
                    ? `Deploy completed${domain ? ` — https://${domain}` : ""}`
                    : `Deploy ${status}${errorMessage ? `: ${errorMessage}` : ""}`}
                </span>
              </div>
            )}
          </div>
        </details>
      </div>

      {/* Sticky status */}
      <div className="lg:sticky lg:top-6 space-y-4">
        <div className="border-2 border-fg bg-bg-raised shadow-neo">
          <div className={`px-4 py-2.5 border-b-2 border-fg ${pill.headerBg} flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg`}>
            <span className={`w-2 h-2 rounded-full ${pill.dot}`} />
            {pill.text}
          </div>
          <div className="p-5 text-center">
            <div className="w-12 h-12 mx-auto border-2 border-fg bg-accent flex items-center justify-center">
              <Rocket size={22} className="text-fg" />
            </div>
            <div className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted">Deploying</div>
            <div className="font-mono font-bold text-base text-fg truncate">
              {appName || (op ? `op #${op.id}` : "—")}
            </div>
            <div className="mt-4 h-3 border-2 border-fg bg-bg overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${failed ? "bg-accent-red" : "bg-accent"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {!terminal && totalSteps > 0 && (
              <div className="mt-2 font-mono text-[9px] uppercase tracking-wider text-muted">
                {completedCount} of {totalSteps}
              </div>
            )}
            <div className={`mt-1.5 font-mono text-[11px] truncate ${failed ? "text-accent-red" : "text-fg-dim"}`}>
              {currentLine}
            </div>
          </div>
        </div>

        {terminal && (
          succeeded ? (
            <Btn
              variant="primary"
              className="w-full !py-2.5"
              onClick={() => {
                window.location.hash = "#/";
              }}
            >
              Go to Dashboard
            </Btn>
          ) : (
            <Btn
              variant="ghost"
              className="w-full !py-2.5"
              onClick={() => {
                window.location.hash = "#/deploy";
              }}
            >
              <ArrowLeft size={14} /> Back
            </Btn>
          )
        )}
      </div>
      </div>
    </div>
  );
}
