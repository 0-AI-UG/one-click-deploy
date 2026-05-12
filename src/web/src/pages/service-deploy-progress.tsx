import { useEffect, useRef } from "react";
import { Btn } from "../components/ui.tsx";
import {
  Database, CheckCircle2, XCircle, Loader2, Circle, Terminal, ArrowLeft,
} from "lucide-react";
import { useOperation, humanizeStep, collapseForwardSteps, TERMINAL_STATUSES } from "../hooks/useOperation.ts";
import type { OperationStep } from "../hooks/useOperation.ts";

export function ServiceDeployProgressPage({ opId }: { opId: number | null }) {
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
  const serviceName = (op as any)?.input?.name ?? "";

  // Redirect to service detail on success via insert_service_and_instance.
  useEffect(() => {
    if (!succeeded) return;
    const insertStep = steps.find((s) => s.step === "insert_service_and_instance" && s.status === "ok");
    const serviceId = insertStep?.output && typeof insertStep.output === "object"
      ? (insertStep.output as { serviceId?: number }).serviceId
      : undefined;
    const t = setTimeout(() => {
      window.location.hash = serviceId ? `#/services/${serviceId}` : "#/";
    }, 1200);
    return () => clearTimeout(t);
  }, [succeeded, steps.length]);

  const statusLabel = succeeded
    ? "● LIVE"
    : failed
      ? "● FAILED"
      : status === "running" || status === "compensating"
        ? "● RUNNING"
        : status === "pending"
          ? "● QUEUED"
          : "● IDLE";

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-fade-in">
      <div className="bg-accent border-2 border-fg shadow-neo-lg p-4 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-bg-raised border-2 border-fg w-10 h-10 flex items-center justify-center">
            <Database size={18} className="text-fg" />
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-fg/70">Deploying Service</div>
            <div className="font-mono font-bold text-sm text-fg">{serviceName || (op ? `op #${op.id}` : "—")}</div>
          </div>
        </div>
        <div className="font-mono text-[9px] uppercase tracking-wider text-fg font-bold">{statusLabel}</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-6">
        <div className="space-y-2">
          {steps.length === 0 && (
            <div className="bg-bg-raised border-2 border-fg shadow-neo-sm p-3 flex items-center gap-3">
              <Loader2 size={16} className="animate-spin text-fg" />
              <span className="font-mono text-[11px] uppercase tracking-wider font-bold text-fg">
                {status === "pending" ? "Added to queue…" : "Starting…"}
              </span>
            </div>
          )}
          {collapseForwardSteps(steps).map((s, i) => {
              const isActive = s.status === "started";
              const isOk = s.status === "ok" || s.status === "skipped";
              const isFailed = s.status === "failed";
              const bg = isOk
                ? "bg-accent-green"
                : isActive
                  ? "bg-accent-amber"
                  : isFailed
                    ? "bg-accent-red"
                    : "bg-bg-raised";
              const shadow = isActive ? "shadow-neo" : "shadow-neo-sm";
              const icon = isOk ? (
                <CheckCircle2 size={16} className="text-fg" />
              ) : isActive ? (
                <Loader2 size={16} className="animate-spin text-fg" />
              ) : isFailed ? (
                <XCircle size={16} className="text-fg" />
              ) : (
                <Circle size={16} className="text-muted" />
              );
              return (
                <div
                  key={s.seq}
                  className={`${bg} border-2 border-fg ${shadow} flex items-center gap-3 p-3 transition-all`}
                >
                  <div className="bg-bg-raised border-2 border-fg w-7 h-7 flex items-center justify-center font-mono text-[10px] font-bold">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {icon}
                    <span className="font-mono text-[11px] uppercase tracking-wider font-bold text-fg">
                      {humanizeStep(s.step)}
                    </span>
                  </div>
                  {s.detail && (
                    <span className="font-mono text-[10px] text-fg/70 truncate ml-auto">
                      {s.detail}
                    </span>
                  )}
                </div>
              );
            })}
        </div>

        <div className="border-2 border-fg shadow-neo bg-fg self-start">
          <div className="flex items-center justify-between bg-fg text-bg px-3 py-1.5 border-b-2 border-bg">
            <div className="flex items-center gap-2">
              <Terminal size={12} />
              <span className="font-mono text-[10px] uppercase tracking-wider font-bold">deploy.log</span>
            </div>
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-accent-red border border-bg" />
              <span className="w-2 h-2 bg-accent-amber border border-bg" />
              <span className="w-2 h-2 bg-accent-green border border-bg" />
            </div>
          </div>
          <div
            ref={logRef}
            className="bg-fg text-bg p-3 h-72 overflow-y-auto font-mono text-[10px] leading-relaxed"
          >
            {steps.length === 0 && !terminal && (
              <div className="flex items-center gap-2 text-accent-amber">
                <Loader2 size={12} className="animate-spin" />
                <span>$ awaiting first event…</span>
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
                    ? "Service deployed successfully"
                    : `Deploy ${status}${errorMessage ? `: ${errorMessage}` : ""}`}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {terminal && (
        <div className="flex gap-3 mt-6">
          {succeeded ? (
            <Btn
              variant="primary"
              className="flex-1 !py-2.5"
              onClick={() => { window.location.hash = "#/"; }}
            >
              Go to Dashboard
            </Btn>
          ) : (
            <Btn
              variant="ghost"
              onClick={() => { window.location.hash = "#/deploy"; }}
            >
              <ArrowLeft size={14} /> Back
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
