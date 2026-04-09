import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, Spinner } from "../components/ui.tsx";
import { Database, CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";

type ProgressEvent = { seq: number; ts: string; step: string; detail: string };

const STEPS = [
  { key: "server", label: "Server" },
  { key: "provision", label: "Provision" },
  { key: "volume", label: "Volume" },
  { key: "service", label: "Service" },
  { key: "deploy", label: "Deploy" },
  { key: "health", label: "Health" },
  { key: "done", label: "Done" },
];

function stepStatus(
  stepKey: string,
  events: ProgressEvent[],
  result: any,
): "pending" | "active" | "done" | "error" {
  const idx = STEPS.findIndex((s) => s.key === stepKey);
  const seenKeys = new Set(events.map((e) => e.step));
  const hasError = events.some((e) => e.step === "error") || result?.ok === false;
  const lastIdx = Math.max(
    -1,
    ...events.map((e) => STEPS.findIndex((s) => s.key === e.step)).filter((i) => i >= 0),
  );
  if (stepKey === "done") return result?.ok ? "done" : hasError ? "error" : "pending";
  if (!seenKeys.has(stepKey)) {
    if (hasError && idx === lastIdx + 1) return "error";
    return "pending";
  }
  if (idx < lastIdx) return "done";
  if (hasError) return "error";
  if (result?.ok) return "done";
  return "active";
}

export function ServiceDeployProgressPage({ jobId }: { jobId: number | null }) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<any>(null);
  const [status, setStatus] = useState<string>("running");
  const logRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef(0);

  useEffect(() => {
    if (!jobId) {
      window.location.hash = "#/deploy-service";
      return;
    }

    let cancelled = false;

    async function poll() {
      while (!cancelled) {
        try {
          const resp = await get(`/api/services/deploy-jobs/${jobId}?since=${sinceRef.current}`);
          if (cancelled) return;

          if (resp.events?.length > 0) {
            setEvents((prev) => [...prev, ...resp.events]);
            sinceRef.current = resp.last_seq;
          }

          if (resp.status !== "running") {
            setResult(resp.result);
            setStatus(resp.status);
            return;
          }
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }

    poll();
    return () => { cancelled = true; };
  }, [jobId]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [events.length]);

  const reusingServer = events.some(
    (e) => e.step === "server" && e.detail?.startsWith("Using server"),
  );
  const visibleSteps = reusingServer
    ? STEPS.filter((s) => s.key !== "server" && s.key !== "provision")
    : STEPS;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      <div className="bg-accent border-2 border-fg p-4 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-bg border-2 border-fg w-10 h-10 flex items-center justify-center">
            <Database size={18} className="text-fg" />
          </div>
          <div>
            <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploying Service</h1>
            <p className="font-mono text-[10px] text-muted">{status === "running" ? "In progress..." : status === "done" ? "Complete" : "Failed"}</p>
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {visibleSteps.map((step) => {
          const s = stepStatus(step.key, events, result);
          return (
            <div key={step.key} className="flex items-center gap-1.5">
              {s === "done" && <CheckCircle2 size={14} className="text-green-500" />}
              {s === "active" && <Loader2 size={14} className="text-accent-blue animate-spin" />}
              {s === "error" && <XCircle size={14} className="text-accent-red" />}
              {s === "pending" && <Circle size={14} className="text-muted" />}
              <span className={`font-mono text-[9px] font-bold uppercase ${
                s === "active" ? "text-accent-blue" : s === "done" ? "text-fg" : s === "error" ? "text-accent-red" : "text-muted"
              }`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Log */}
      <Card>
        <div className="px-4 py-2 border-b-2 border-fg bg-alt">
          <span className="font-mono text-[10px] font-bold text-fg uppercase">Deploy Log</span>
        </div>
        <div ref={logRef} className="p-4 max-h-80 overflow-auto font-mono text-[10px] space-y-0.5">
          {events.map((e, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-muted shrink-0">[{e.step}]</span>
              <span className="text-fg">{e.detail}</span>
            </div>
          ))}
          {events.length === 0 && status === "running" && (
            <div className="text-muted">Waiting for events...</div>
          )}
        </div>
      </Card>

      {/* Result */}
      {result && (
        <div className="mt-4 flex gap-2">
          {result.ok ? (
            <>
              <Btn variant="primary" onClick={() => {
                const svcId = result.serviceId;
                if (svcId) window.location.hash = `#/services/${svcId}`;
                else window.location.hash = "#/";
              }}>
                View Service
              </Btn>
              <Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}>
                Dashboard
              </Btn>
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] text-accent-red py-2">{result.error}</div>
              <Btn variant="ghost" onClick={() => { window.location.hash = "#/deploy-service"; }}>
                Try Again
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
