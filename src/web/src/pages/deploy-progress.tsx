import { useEffect, useRef } from "react";
import { Btn } from "../components/ui.tsx";
import { CheckCircle2, XCircle, Loader2, Circle, Rocket, Terminal } from "lucide-react";
import { useDeployProgress, clearDeploy, resumeDeploy, type ProgressEvent, type DeployResult } from "../stores/deploy-progress.ts";

const DEPLOY_STEPS: { key: string; label: string }[] = [
  { key: "server", label: "Server" },
  { key: "provision", label: "Provision" },
  { key: "dns", label: "DNS" },
  { key: "build", label: "Build" },
  { key: "caddy", label: "TLS / Proxy" },
  { key: "health", label: "Health" },
  { key: "done", label: "Done" },
];

function stepStatus(
  stepKey: string,
  events: ProgressEvent[],
  result: DeployResult,
): "pending" | "active" | "done" | "error" {
  const idx = DEPLOY_STEPS.findIndex((s) => s.key === stepKey);
  const seenKeys = new Set(events.map((e) => e.step));
  const hasError = events.some((e) => e.step === "error") || result?.ok === false;
  const lastIdx = Math.max(
    -1,
    ...events.map((e) => DEPLOY_STEPS.findIndex((s) => s.key === e.step)).filter((i) => i >= 0),
  );
  if (stepKey === "done") {
    return result?.ok ? "done" : hasError ? "error" : "pending";
  }
  if (!seenKeys.has(stepKey)) {
    if (hasError && idx === lastIdx + 1) return "error";
    return "pending";
  }
  if (idx < lastIdx) return "done";
  if (hasError) return "error";
  if (result?.ok) return "done";
  return "active";
}

export function DeployProgressPage({ jobId }: { jobId: number | null }) {
  const { active, appName, progress, result, jobId: storeJobId } = useDeployProgress();
  const logRef = useRef<HTMLDivElement>(null);

  // Resume polling if the URL points at a job we're not already watching
  // (e.g. after a page reload).
  useEffect(() => {
    if (jobId && jobId !== storeJobId) {
      resumeDeploy(jobId);
    }
  }, [jobId, storeJobId]);

  // If we landed here with no jobId in the URL and nothing in the store,
  // send the user back to the deploy form.
  useEffect(() => {
    if (!jobId && !active && !result && progress.length === 0) {
      window.location.hash = "#/deploy";
    }
  }, [jobId, active, result, progress.length]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [progress.length]);

  const reusingServer = progress.some(
    (e) => e.step === "server" && e.detail?.startsWith("Using server"),
  );
  const visibleSteps = reusingServer
    ? DEPLOY_STEPS.filter((s) => s.key !== "server" && s.key !== "provision")
    : DEPLOY_STEPS;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-fade-in">
      {/* Header bar */}
      <div className="bg-accent border-2 border-fg shadow-neo-lg p-4 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-bg-raised border-2 border-fg w-10 h-10 flex items-center justify-center">
            <Rocket size={18} className="text-fg" />
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-fg/70">Deploying</div>
            <div className="font-mono font-bold text-sm text-fg">{appName || "—"}</div>
          </div>
        </div>
        <div className="font-mono text-[9px] uppercase tracking-wider text-fg font-bold">
          {result?.ok ? "● LIVE" : result ? "● FAILED" : active ? "● RUNNING" : "● IDLE"}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-6">
      {/* Step list — chunky vertical blocks */}
      <div className="space-y-2">
        {visibleSteps.map((s, i) => {
          const status = stepStatus(s.key, progress, result);
          const lastDetail = [...progress].reverse().find((e) => e.step === s.key)?.detail;
          const bg =
            status === "done"
              ? "bg-accent-green"
              : status === "active"
              ? "bg-accent-amber"
              : status === "error"
              ? "bg-accent-red"
              : "bg-bg-raised";
          const shadow = status === "active" ? "shadow-neo" : "shadow-neo-sm";
          const icon =
            status === "done" ? (
              <CheckCircle2 size={16} className="text-fg" />
            ) : status === "active" ? (
              <Loader2 size={16} className="animate-spin text-fg" />
            ) : status === "error" ? (
              <XCircle size={16} className="text-fg" />
            ) : (
              <Circle size={16} className="text-muted" />
            );
          return (
            <div
              key={s.key}
              className={`${bg} border-2 border-fg ${shadow} flex items-center gap-3 p-3 transition-all`}
            >
              <div className="bg-bg-raised border-2 border-fg w-7 h-7 flex items-center justify-center font-mono text-[10px] font-bold">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {icon}
                <span className="font-mono text-[11px] uppercase tracking-wider font-bold text-fg">
                  {s.label}
                </span>
              </div>
              {lastDetail && (
                <span className="font-mono text-[10px] text-fg/70 truncate ml-auto">
                  {lastDetail}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Terminal-style log window */}
      <div className="border-2 border-fg shadow-neo bg-fg self-start">
        <div className="flex items-center justify-between bg-fg text-bg px-3 py-1.5 border-b-2 border-bg">
          <div className="flex items-center gap-2">
            <Terminal size={12} />
            <span className="font-mono text-[10px] uppercase tracking-wider font-bold">
              deploy.log
            </span>
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
          {progress.length === 0 && active && (
            <div className="flex items-center gap-2 text-accent-amber">
              <Loader2 size={12} className="animate-spin" />
              <span>$ awaiting first event…</span>
            </div>
          )}
          {progress.map((ev, i) => {
            const isError = ev.step === "error";
            return (
              <div key={i} className={`flex gap-2 ${isError ? "text-accent-red" : "text-bg"}`}>
                <span className="text-accent-amber shrink-0">›</span>
                <span className="text-muted shrink-0 w-20 uppercase">[{ev.step}]</span>
                <span className="whitespace-pre-wrap break-all">{ev.detail}</span>
              </div>
            );
          })}
          {result && (
            <div
              className={`flex items-center gap-2 mt-3 pt-2 border-t-2 border-bg ${
                result.ok ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <span className="font-bold">
                {result.ok ? "Deploy completed successfully" : `Deploy failed: ${result.error}`}
              </span>
            </div>
          )}
        </div>
      </div>
      </div>

      {/* Actions */}
      {result && (
        <div className="flex gap-3 mt-6">
          {result.ok ? (
            <>
              <Btn
                variant="primary"
                className="flex-1 !py-2.5"
                onClick={() => {
                  clearDeploy();
                  window.location.hash = "#/";
                }}
              >
                Go to Dashboard
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  clearDeploy();
                  window.location.hash = "#/deploy";
                }}
              >
                Deploy another
              </Btn>
            </>
          ) : (
            <Btn
              variant="primary"
              className="flex-1 !py-2.5"
              onClick={() => {
                clearDeploy();
                window.location.hash = "#/deploy";
              }}
            >
              Back to form
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
