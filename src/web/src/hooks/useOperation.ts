import { useEffect, useRef, useState, useCallback } from "react";
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

export type OperationStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "compensating"
  | "compensated"
  | "cancelled";

export type OperationView = {
  id: number;
  kind: string;
  label: string;
  resource_keys: string[];
  resource_labels?: string[];
  input?: Record<string, unknown>;
  status: OperationStatus;
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
    status: OperationStatus;
    resource_keys: string[];
    resource_labels?: string[];
  }>;
};

export const TERMINAL_STATUSES = new Set<OperationStatus>([
  "done",
  "failed",
  "cancelled",
  "compensated",
]);

export function isTerminal(status: OperationStatus | string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status as OperationStatus);
}

export function humanizeStep(step: string | null | undefined): string {
  if (!step) return "";
  return step.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// The step stream contains one event per state change (started, then ok/skipped/failed).
// For the progress UI we want one row per step name, reflecting its latest state.
// Order is preserved by first-seen seq so rows don't jump as later events arrive.
export function collapseForwardSteps(steps: OperationStep[]): OperationStep[] {
  const latest = new Map<string, OperationStep>();
  const firstSeq = new Map<string, number>();
  for (const s of steps) {
    if (s.phase !== "forward") continue;
    if (!firstSeq.has(s.step)) firstSeq.set(s.step, s.seq);
    const prev = latest.get(s.step);
    // `>=` so a re-delivered same-seq row (started → ok, mutated in place)
    // replaces the earlier state rather than being dropped.
    if (!prev || s.seq >= prev.seq) latest.set(s.step, s);
  }
  return Array.from(latest.values()).sort(
    (a, b) => (firstSeq.get(a.step)! - firstSeq.get(b.step)!),
  );
}

// Ops that already have a sticky toast attached. Guards against double-toasts
// when multiple hooks (or remounts) discover the same running op.
const rehydratedToastIds = new Set<number>();

type PollEvent = {
  status: OperationStatus;
  last_step: string | null;
  error: OperationView["error"];
  newSteps: OperationStep[];
};

/**
 * Core long-poll loop. Calls `onEvent` whenever the server returns new state,
 * then resolves once the op reaches a terminal status or the signal aborts.
 * Used by every higher-level consumer in this module.
 */
export async function pollOperation(
  opId: number,
  onEvent: (ev: PollEvent) => void,
  signal: { aborted: boolean },
  initialSince = 0,
): Promise<OperationStatus | null> {
  let since = initialSince;
  while (!signal.aborted) {
    let data: {
      status: OperationStatus;
      last_step: string | null;
      error: OperationView["error"];
      steps?: OperationStep[];
    };
    try {
      data = await get(`/api/operations/${opId}/events?since=${since}&wait=15000`);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (signal.aborted) return null;
    const newSteps = Array.isArray(data.steps) ? data.steps : [];
    if (newSteps.length > 0) since = newSteps[newSteps.length - 1].seq;
    onEvent({
      status: data.status,
      last_step: data.last_step,
      error: data.error ?? null,
      newSteps,
    });
    if (isTerminal(data.status)) return data.status;
  }
  return null;
}

/**
 * Subscribe to a single op's live state. Returns current snapshot + full step list.
 */
export function useOperation(opId: number | null): OperationView | null {
  const [view, setView] = useState<OperationView | null>(null);

  useEffect(() => {
    if (!opId) {
      setView(null);
      return;
    }
    const signal = { aborted: false };
    const accumulated: OperationStep[] = [];

    (async () => {
      let initialSince = 0;
      try {
        const initial = await get(`/api/operations/${opId}`);
        if (signal.aborted) return;
        const steps: OperationStep[] = initial.steps || [];
        accumulated.push(...steps);
        if (steps.length > 0) initialSince = steps[steps.length - 1].seq;
        setView({ ...initial, steps: [...accumulated] });
      } catch {
        /* poll loop will populate */
      }
      await pollOperation(
        opId,
        (ev) => {
          accumulated.push(...ev.newSteps);
          setView((prev) =>
            prev
              ? { ...prev, status: ev.status, last_step: ev.last_step, error: ev.error, steps: [...accumulated] }
              : prev,
          );
        },
        signal,
        initialSince,
      );
    })();

    return () => {
      signal.aborted = true;
    };
  }, [opId]);

  return view;
}

export type ResourceOpsResult = {
  active: OperationView[];
  isBusy: boolean;
  isBusyWith: (kind: string) => boolean;
  byResourceKey: (key: string) => OperationView | null;
  latest: OperationView | null;
  track: (opId: number) => void;
  refresh: () => void;
};

type ResourceOpsOptions = {
  /**
   * When true, any running/pending op discovered via the initial
   * `/api/operations` fetch (i.e. not announced to the hook via `track`) will
   * get its own sticky toast. This is how page-reload recovery gets its toast
   * back. Ops added via `track(opId)` are assumed to have been toasted already
   * by the caller and never double-toast.
   */
  rehydrateToasts?: boolean;
};

/**
 * Track every active operation touching a given resource key (e.g. `app:42`).
 *
 * On mount, primes from `GET /api/operations` so a page reload mid-op picks
 * the state back up. After a new action, call `track(opId)` with the id
 * returned from the POST so it's tracked immediately without waiting for
 * the next refresh.
 *
 * `latest` is the most-recently-updated tracked op (active or freshly
 * terminal). `isBusy` is true while any tracked op is non-terminal.
 * Terminal ops linger for ~2s in `active` so callers can render a final
 * state, then drop out.
 */
/**
 * Track every active operation matching a filter. Core machinery behind
 * `useResourceOperations` and `useActiveOperations` — not exported directly.
 */
function useOperationTracker(
  filter: ((op: OperationView) => boolean) | null,
  options: ResourceOpsOptions = {},
): ResourceOpsResult {
  const { rehydrateToasts = false } = options;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [views, setViews] = useState<Record<number, OperationView>>({});
  const tracked = useRef<Set<number>>(new Set());
  const signals = useRef<Map<number, { aborted: boolean }>>(new Map());
  const accum = useRef<Map<number, OperationStep[]>>(new Map());
  const mounted = useRef(true);
  const rehydrateRef = useRef(rehydrateToasts);
  rehydrateRef.current = rehydrateToasts;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const sig of signals.current.values()) sig.aborted = true;
      signals.current.clear();
      tracked.current.clear();
      accum.current.clear();
    };
  }, []);

  const startTracking = useCallback((opId: number, opts: { toast?: boolean; label?: string } = {}) => {
    if (tracked.current.has(opId)) return;
    tracked.current.add(opId);
    if (opts.toast && !rehydratedToastIds.has(opId)) {
      trackOperationInToast(opId, opts.label || "Operation");
    }
    const signal = { aborted: false };
    signals.current.set(opId, signal);
    accum.current.set(opId, []);

    (async () => {
      let initialSince = 0;
      try {
        const initial: OperationView = await get(`/api/operations/${opId}`);
        if (!mounted.current || signal.aborted) return;
        const steps = initial.steps || [];
        accum.current.get(opId)!.push(...steps);
        if (steps.length > 0) initialSince = steps[steps.length - 1].seq;
        setViews((prev) => ({ ...prev, [opId]: { ...initial, steps: [...accum.current.get(opId)!] } }));
      } catch {
        /* poll will populate */
      }
      await pollOperation(
        opId,
        (ev) => {
          if (!mounted.current) return;
          accum.current.get(opId)?.push(...ev.newSteps);
          setViews((prev) => {
            const cur = prev[opId];
            if (!cur) return prev;
            return {
              ...prev,
              [opId]: {
                ...cur,
                status: ev.status,
                last_step: ev.last_step,
                error: ev.error,
                steps: [...(accum.current.get(opId) || [])],
              },
            };
          });
        },
        signal,
        initialSince,
      );
      if (!mounted.current) return;
      setTimeout(() => {
        if (!mounted.current) return;
        tracked.current.delete(opId);
        signals.current.delete(opId);
        accum.current.delete(opId);
        setViews((prev) => {
          const next = { ...prev };
          delete next[opId];
          return next;
        });
      }, 2000);
    })();
  }, []);

  const refresh = useCallback(() => {
    const fn = filterRef.current;
    if (!fn) return;
    (async () => {
      try {
        const data = await get("/api/operations");
        if (!mounted.current) return;
        const candidates: OperationView[] = [...(data.running || []), ...(data.pending || [])];
        for (const op of candidates) {
          if (fn(op)) {
            startTracking(op.id, { toast: rehydrateRef.current, label: op.label });
          }
        }
      } catch {
        /* ignore — next action will call track(opId) explicitly */
      }
    })();
  }, [startTracking]);

  const enabled = !!filter;
  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  const active = Object.values(views).sort((a, b) => a.id - b.id);
  const nonTerminal = active.filter((v) => !isTerminal(v.status));
  const latest = nonTerminal.length
    ? nonTerminal[nonTerminal.length - 1]
    : active.length
      ? active[active.length - 1]
      : null;

  const isBusyWith = useCallback(
    (kind: string) => nonTerminal.some((v) => v.kind === kind),
    [nonTerminal],
  );

  const byResourceKey = useCallback(
    (key: string) => nonTerminal.find((v) => v.resource_keys?.includes(key)) ?? null,
    [nonTerminal],
  );

  const track = useCallback((opId: number) => startTracking(opId), [startTracking]);

  return { active, isBusy: nonTerminal.length > 0, isBusyWith, byResourceKey, latest, track, refresh };
}

/**
 * Track every active operation touching a given resource key (e.g. `app:42`).
 *
 * On mount, primes from `GET /api/operations` so a page reload mid-op picks
 * the state back up. After a new action, call `track(opId)` with the id
 * returned from the POST so it's tracked immediately without waiting for
 * the next refresh.
 *
 * `latest` is the most-recently-updated tracked op (active or freshly
 * terminal). `isBusy` is true while any tracked op is non-terminal.
 * Terminal ops linger for ~2s in `active` so callers can render a final
 * state, then drop out.
 */
export function useResourceOperations(
  resourceKey: string | null,
  options: ResourceOpsOptions = {},
): ResourceOpsResult {
  const filter = useCallback(
    (op: OperationView) => !!resourceKey && op.resource_keys?.includes(resourceKey),
    [resourceKey],
  );
  return useOperationTracker(resourceKey ? filter : null, options);
}

/**
 * Like `useResourceOperations` but subscribes to every active op matching
 * `filter`. For pages that touch many resource keys (e.g. the resources
 * list) where per-row `useResourceOperations` isn't feasible. Use
 * `byResourceKey(...)` on the result to look up the op for a given row.
 */
export function useActiveOperations(
  filter: (op: OperationView) => boolean = () => true,
  options: ResourceOpsOptions = {},
): ResourceOpsResult {
  return useOperationTracker(filter, options);
}

/**
 * Fire-and-forget sticky toast that follows an op through its lifecycle.
 * Returns a promise that resolves to the terminal status (or null if the
 * page unloads first). Safe to `await` when the caller also needs to know
 * when the op finished.
 */
export function trackOperationInToast(
  opId: number,
  label: string,
): Promise<OperationStatus | null> {
  // Reserve the id so rehydration paths don't double-toast if this op is
  // still running when a page remounts.
  rehydratedToastIds.add(opId);
  const toast = showLiveToast({ message: label, subtitle: "Added to queue", type: "info" });
  const signal = { aborted: false };
  let lastStatus: OperationStatus = "pending";
  let lastStep: string | null = null;

  function render() {
    const subtitle =
      lastStatus === "pending"
        ? "Added to queue"
        : lastStatus === "running"
          ? lastStep
            ? `Working on it: ${humanizeStep(lastStep)}…`
            : "Working on it…"
          : lastStatus === "compensating"
            ? "Rolling back…"
            : lastStatus;
    toast.update({ subtitle });
  }

  return pollOperation(
    opId,
    (ev) => {
      lastStatus = ev.status || lastStatus;
      if (ev.last_step) lastStep = ev.last_step;
      for (const s of ev.newSteps) {
        if (s.phase === "forward" && s.status === "started") lastStep = s.step;
      }
      render();
      if (isTerminal(ev.status)) {
        if (ev.status === "done") {
          toast.update({ message: `${label} ✓`, subtitle: "Finished", type: "success" });
        } else if (ev.status === "cancelled") {
          toast.update({ message: `${label} cancelled`, subtitle: "", type: "info" });
        } else {
          toast.update({
            message: `${label} failed`,
            subtitle: ev.error?.message || "Failed",
            type: "error",
          });
        }
        toast.dismiss(5000);
      }
    },
    signal,
  ).finally(() => {
    rehydratedToastIds.delete(opId);
  });
}

export async function cancelOperation(opId: number): Promise<void> {
  await post(`/api/operations/${opId}/cancel`);
}

