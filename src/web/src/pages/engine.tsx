import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { get } from "../api/client.ts";
import { Spinner } from "../components/ui.tsx";
import { humanizeStep, type OperationView } from "../hooks/useOperation.ts";

type Snapshot = {
  running: OperationView[];
  pending: OperationView[];
  recent: OperationView[];
  engine: {
    heartbeat: string | null;
    concurrency: number;
    known_kinds: Array<{ kind: string; label: string; steps: number }>;
  };
};

function statusColor(status: string): string {
  if (status === "done") return "bg-accent text-fg";
  if (status === "running") return "bg-accent-blue text-white";
  if (status === "pending") return "bg-alt text-fg";
  if (status === "failed" || status === "compensated") return "bg-accent-red text-white";
  if (status === "compensating") return "bg-accent-amber text-fg";
  if (status === "cancelled") return "bg-alt text-fg-dim";
  return "bg-alt text-fg";
}

function heartbeatLabel(raw: string | null): { text: string; healthy: boolean } {
  if (!raw) return { text: "no heartbeat", healthy: false };
  const last = new Date(raw).getTime();
  const age = Date.now() - last;
  if (age < 15000) return { text: `${Math.round(age / 1000)}s ago`, healthy: true };
  return { text: `stale (${Math.round(age / 1000)}s)`, healthy: false };
}

export function EnginePage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const data = await get("/api/operations");
        if (!cancelled) setSnap(data);
      } catch {
        /* ignore */
      }
    }
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (!snap) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const hb = heartbeatLabel(snap.engine.heartbeat);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-mono text-xl font-bold uppercase tracking-wider">Engine</h1>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono font-bold uppercase tracking-wider">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 border-2 border-fg shadow-neo-sm ${
              hb.healthy ? "bg-accent text-fg" : "bg-accent-red text-white"
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${hb.healthy ? "bg-fg" : "bg-white"}`} />
            Heartbeat {hb.text}
          </span>
          <span className="px-2 py-1 border-2 border-fg bg-bg-raised shadow-neo-sm">
            Concurrency {snap.engine.concurrency}
          </span>
        </div>
      </div>

      <Section title="Running" count={snap.running.length}>
        {snap.running.length === 0 ? (
          <EmptyState label="No operations running" />
        ) : (
          <OpList ops={snap.running} showProgress />
        )}
      </Section>

      <Section title="Pending" count={snap.pending.length}>
        {snap.pending.length === 0 ? (
          <EmptyState label="Queue is empty" />
        ) : (
          <OpList ops={snap.pending} />
        )}
      </Section>

      <Section title="Recent" count={snap.recent.length}>
        {snap.recent.length === 0 ? (
          <EmptyState label="No operations yet" />
        ) : (
          <OpList ops={snap.recent} />
        )}
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-wider">{title}</h2>
        <span className="text-[10px] font-mono text-fg-dim">({count})</span>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="border-2 border-dashed border-fg/30 py-8 text-center text-xs font-mono text-fg-dim">
      {label}
    </div>
  );
}

function OpList({ ops, showProgress }: { ops: OperationView[]; showProgress?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {ops.map((op) => (
        <OpRow key={op.id} op={op} showProgress={showProgress} />
      ))}
    </div>
  );
}

function OpRow({ op, showProgress }: { op: OperationView; showProgress?: boolean }) {
  const progress =
    showProgress && op.total_steps > 0 && op.last_step
      ? `${op.last_step}`
      : null;
  const resource = (op.resource_labels ?? op.resource_keys).join(", ");
  const age = op.started_at
    ? formatDistanceToNow(new Date(op.started_at.replace(" ", "T") + "Z"), { addSuffix: true })
    : null;
  return (
    <a
      href={`#/engine/op/${op.id}`}
      className="block border-2 border-fg bg-bg-raised shadow-neo-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none transition-all px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span
          className={`font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-2 border-fg ${statusColor(op.status)}`}
        >
          {op.status}
        </span>
        <span className="font-mono text-xs font-bold">{op.kind}</span>
        <span className="font-mono text-[10px] text-fg-dim">#{op.id}</span>
        <span className="font-mono text-[10px] text-fg-dim">{resource}</span>
        <span className="font-mono text-[10px] text-fg-dim ml-auto">
          {op.trigger}
          {age ? ` · ${age}` : ""}
        </span>
      </div>
      {progress && (
        <div className="mt-1 font-mono text-[10px] text-fg-dim">
          {humanizeStep(progress)}
        </div>
      )}
      {op.error?.message && (
        <div className="mt-1 font-mono text-[10px] text-accent-red truncate">
          {op.error.message}
        </div>
      )}
    </a>
  );
}
