import { ArrowLeft, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { get } from "../api/client.ts";
import { Spinner, Btn } from "../components/ui.tsx";
import { useOperation, TERMINAL_STATUSES } from "../hooks/useOperation.ts";

type LogRow = {
  id: number;
  op_id: number;
  ts: string;
  level: string;
  message: string;
};

export function EngineOpLogsPage({ opId }: { opId: number }) {
  const op = useOperation(opId);
  const active = op ? !TERMINAL_STATUSES.has(op.status) : true;

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    sinceRef.current = 0;
    setLogs([]);
    setLoaded(false);

    async function tick() {
      while (!cancelled) {
        try {
          const wait = active ? 15000 : 0;
          const data = await get(`/api/operations/${opId}/logs?since=${sinceRef.current}&wait=${wait}`);
          if (cancelled) return;
          const rows: LogRow[] = Array.isArray(data.logs) ? data.logs : [];
          if (rows.length > 0) {
            sinceRef.current = rows[rows.length - 1].id;
            setLogs((prev) => [...prev, ...rows]);
          }
          setLoaded(true);
          const terminal = ["done", "failed", "cancelled", "compensated"].includes(data.status);
          if (terminal && rows.length === 0) return;
          if (!active && rows.length === 0) return;
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    tick();
    return () => { cancelled = true; };
  }, [opId, active]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  function downloadLogs() {
    const text = logs
      .map((l) => `${l.ts} ${l.level.toUpperCase().padEnd(5)} ${l.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `op-${opId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const needle = filter.trim().toLowerCase();
  const visible = needle ? logs.filter((l) => l.message.toLowerCase().includes(needle)) : logs;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = `#/engine/op/${opId}`; }}>
          <ArrowLeft size={14} />
        </Btn>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-mono text-xl font-bold uppercase tracking-wider">
            Logs
            <span className="ml-2 font-mono text-sm text-fg-dim">
              {op ? op.kind : ""} #{opId}
            </span>
          </h1>
          {op && (
            <div className="mt-2 text-xs text-fg-dim font-mono">
              {(op.resource_labels ?? op.resource_keys).join(", ")} · status {op.status}
              {active ? " · live" : ""}
            </div>
          )}
        </div>
        <button
          onClick={downloadLogs}
          disabled={logs.length === 0}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg bg-bg-raised text-fg px-3 py-1.5 shadow-neo-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none transition-all disabled:opacity-50 disabled:pointer-events-none"
        >
          <Download size={12} /> Download
        </button>
      </div>

      {!loaded && !op ? (
        <div className="min-h-[200px] flex items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="border-2 border-fg bg-bg-raised shadow-neo-sm">
          <div className="flex items-center gap-3 px-2 py-1.5 border-b-2 border-fg bg-alt">
            <input
              type="text"
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1 font-mono text-[11px] bg-bg border-2 border-fg px-2 py-1 focus:outline-none"
            />
            <span className="font-mono text-[10px] text-fg-dim">
              {visible.length}{needle ? `/${logs.length}` : ""} lines
            </span>
            <label className="flex items-center gap-1.5 font-mono text-[10px] text-fg-dim cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>
          </div>
          <div
            ref={scrollRef}
            className="h-[70vh] overflow-auto bg-fg text-bg p-2 font-mono text-[10px] leading-relaxed"
          >
            {visible.length === 0 ? (
              <div className="text-bg/60 p-2">
                {loaded ? (needle ? "No matches." : "No log lines captured yet.") : "Loading…"}
              </div>
            ) : (
              visible.map((l) => (
                <div key={l.id} className="whitespace-pre-wrap break-words">
                  <span className="text-bg/60">{fmtLogTs(l.ts)} </span>
                  <span className={logLevelClass(l.level)}>{l.level.toUpperCase().padEnd(5)} </span>
                  <span>{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtLogTs(ts: string): string {
  try {
    return new Date(ts.replace(" ", "T") + "Z").toLocaleTimeString();
  } catch {
    return ts;
  }
}

function logLevelClass(level: string): string {
  if (level === "error") return "text-accent-red";
  if (level === "warn") return "text-accent-amber";
  return "text-accent";
}
