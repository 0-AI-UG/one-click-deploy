import { Card, Btn } from "../../components/ui.tsx";
import { LogViewer } from "../../components/log-viewer.tsx";
import { ScrollText, RefreshCw } from "lucide-react";

/**
 * The stack's own deploy log (`stacks.deploy_log`) — the plan/apply narration
 * written by `deploy_stack`, plus the membership and settings changes made from
 * this page. Distinct from any single member's container logs, which live on the
 * app detail page.
 */
export function StackLogsTab({ log, reload }: { log: string; reload: () => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ScrollText size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Stack Deploy Log</h3>
        </div>
        <Btn size="xs" onClick={reload}><RefreshCw size={12} /> Refresh</Btn>
      </div>
      <LogViewer logs={log} />
    </Card>
  );
}
