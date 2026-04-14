import { useEffect, useState } from "react";
import { get, post } from "../api/client.ts";
import { showLiveToast } from "../components/ui.tsx";

export type OperationStep = {
  seq: number;
  step: string;
  phase: "forward" | "compensate";
  status: "started" | "ok" | "skipped" | "failed";
  detail: string;
  output: unknown;
  started_at: string;
  finished_at: string | null;
};

export type OperationView = {
  id: number;
  kind: string;
  resource_keys: string[];
  status: "pending" | "running" | "done" | "failed" | "compensating" | "compensated" | "cancelled";
  last_step: string | null;
  trigger: string;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: { message?: string; cancelled?: boolean } | null;
  total_steps: number;
  attempt: number;
  steps?: OperationStep[];
  children?: Array<{
    id: number;
    kind: string;
    status: OperationView["status"];
    resource_keys: string[];
  }>;
};

export const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
]);

/**
 * Subscribe to an op's live state. Returns current snapshot + step list.
 * Internally long-polls /api/operations/:id/events.
 */
export function useOperation(opId: number | null): OperationView | null {
  const [view, setView] = useState<OperationView | null>(null);

  useEffect(() => {
    if (!opId) {
      setView(null);
      return;
    }
    let cancelled = false;
    let since = 0;
    const accumulatedSteps: OperationStep[] = [];

    async function prime() {
      try {
        const initial = await get(`/api/operations/${opId}`);
        if (cancelled) return;
        const steps: OperationStep[] = initial.steps || [];
        accumulatedSteps.push(...steps);
        since = steps.length ? steps[steps.length - 1].seq : 0;
        setView({ ...initial, steps: [...accumulatedSteps] });
      } catch {
        /* ignore — poll loop will retry */
      }
      loop();
    }

    async function loop() {
      while (!cancelled) {
        try {
          const data = await get(`/api/operations/${opId}/events?since=${since}&wait=15000`);
          if (cancelled) return;
          if (Array.isArray(data.steps) && data.steps.length > 0) {
            accumulatedSteps.push(...data.steps);
            since = data.steps[data.steps.length - 1].seq;
          }
          setView((prev) =>
            prev
              ? {
                  ...prev,
                  status: data.status ?? prev.status,
                  last_step: data.last_step ?? prev.last_step,
                  error: data.error ?? prev.error,
                  steps: [...accumulatedSteps],
                }
              : prev,
          );
          if (TERMINAL_STATUSES.has(data.status)) return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    prime();
    return () => {
      cancelled = true;
    };
  }, [opId]);

  return view;
}

export function humanizeStep(step: string | null | undefined): string {
  if (!step) return "";
  return step.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Fire-and-forget: start a sticky toast that follows an op through its lifecycle.
 * Call right after POSTing an action that returns `{ opId }`.
 */
export function trackOperationInToast(opId: number, label: string): void {
  const toast = showLiveToast({
    message: label,
    subtitle: "Added to queue",
    type: "info",
  });

  let since = 0;
  let stopped = false;
  let lastStatus = "pending";
  let lastStep: string | null = null;

  function render() {
    const statusLine =
      lastStatus === "pending"
        ? "Added to queue"
        : lastStatus === "running"
          ? lastStep
            ? `Working on it — ${humanizeStep(lastStep)}…`
            : "Working on it…"
          : lastStatus === "compensating"
            ? "Rolling back…"
            : lastStatus;
    toast.update({ subtitle: statusLine });
  }

  async function loop() {
    while (!stopped) {
      try {
        const data = await get(`/api/operations/${opId}/events?since=${since}&wait=15000`);
        lastStatus = data.status || lastStatus;
        if (data.last_step) lastStep = data.last_step;
        if (Array.isArray(data.steps) && data.steps.length > 0) {
          const last = data.steps[data.steps.length - 1];
          since = last.seq;
          if (last.phase === "forward" && last.status === "started") {
            lastStep = last.step;
          }
        }
        render();
        if (TERMINAL_STATUSES.has(lastStatus)) {
          if (lastStatus === "done") {
            toast.update({ message: `${label} ✓`, subtitle: "Finished", type: "success" });
          } else if (lastStatus === "cancelled") {
            toast.update({ message: `${label} cancelled`, subtitle: "", type: "info" });
          } else {
            const err = data.error?.message || "Failed";
            toast.update({ message: `${label} failed`, subtitle: err, type: "error" });
          }
          toast.dismiss(5000);
          return;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  loop();
  // The caller has no handle to stop; the toast auto-dismisses on terminal.
}

export async function cancelOperation(opId: number): Promise<void> {
  await post(`/api/operations/${opId}/cancel`);
}
