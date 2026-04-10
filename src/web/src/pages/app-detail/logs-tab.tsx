import { Card, Btn } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { ScrollText, RefreshCw } from "lucide-react";

interface LogsTabProps {
  logs: string;
  tail: number;
  setTail: (t: number) => void;
  loadLogs: () => void;
}

export function LogsTab({ logs, tail, setTail, loadLogs }: LogsTabProps) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ScrollText size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container Logs</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-24">
            <NeoSelect
              value={String(tail)}
              onChange={(v) => setTail(parseInt(v))}
              options={[50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} lines` }))}
              compact
            />
          </div>
          <Btn size="xs" onClick={loadLogs}><RefreshCw size={12} /> Refresh</Btn>
        </div>
      </div>
      <pre className="bg-fg border-2 border-fg p-3 max-h-96 overflow-auto text-[10px] font-mono text-accent/80 whitespace-pre-wrap">{logs || "Loading..."}</pre>
    </Card>
  );
}
