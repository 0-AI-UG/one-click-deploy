import { ArrowLeft, Download, ScrollText, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, Spinner } from "../components/ui.tsx";
import { LogViewer } from "../components/log-viewer.tsx";
import { useOperation, TERMINAL_STATUSES } from "../hooks/useOperation.ts";

type LogRow = {
  id: number;
  op_id: number;
  ts: string;
  level: string;
  message: string;
};

function rowToLine(l: LogRow): string {
  const level = l.level.toUpperCase();
  return `${l.ts} ${level} ${l.message}`;
}

export function EngineOpLogsPage({ opId }: { opId: number }) {
  const op = useOperation(opId);
  const active = op ? !TERMINAL_STATUSES.has(op.status) : true;

  const [rows, setRows] = useState<LogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const sinceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    sinceRef.current = 0;
    setRows([]);
    setLoaded(false);

    async function tick() {
      while (!cancelled) {
        try {
          const wait = active ? 15000 : 0;
          const data = await get(`/api/operations/${opId}/logs?since=${sinceRef.current}&wait=${wait}`);
          if (cancelled) return;
          const incoming: LogRow[] = Array.isArray(data.logs) ? data.logs : [];
          if (incoming.length > 0) {
            sinceRef.current = incoming[incoming.length - 1].id;
            setRows((prev) => [...prev, ...incoming]);
          }
          setLoaded(true);
          const terminal = ["done", "failed", "cancelled", "compensated"].includes(data.status);
          if (terminal && incoming.length === 0) return;
          if (!active && incoming.length === 0) return;
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    tick();
    return () => { cancelled = true; };
  }, [opId, active, reloadTick]);

  const logsText = useMemo(() => rows.map(rowToLine).join("\n"), [rows]);

  function downloadLogs() {
    const blob = new Blob([logsText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `op-${opId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in">
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
      </div>

      {!loaded && !op ? (
        <div className="min-h-[200px] flex items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ScrollText size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">
                Engine Logs ({rows.length} lines)
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <Btn size="xs" onClick={downloadLogs} disabled={rows.length === 0}>
                <Download size={12} /> Download
              </Btn>
              <Btn size="xs" onClick={() => setReloadTick((t) => t + 1)}>
                <RefreshCw size={12} /> Refresh
              </Btn>
            </div>
          </div>
          <LogViewer
            logs={logsText || (loaded ? "No log lines captured yet." : "")}
            className="max-h-[70vh]"
          />
        </Card>
      )}
    </div>
  );
}
