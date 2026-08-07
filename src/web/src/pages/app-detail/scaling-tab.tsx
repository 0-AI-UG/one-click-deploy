import { post } from "../../api/client.ts";
import { Card, Btn, Table } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Zap, Gauge, History } from "lucide-react";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, ScalingEvent } from "../../types.ts";

interface ScalingTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  scalingEvents: ScalingEvent[];
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function ScalingTab({
  app,
  appId,
  replicas,
  scalingEvents,
  actionLoading,
  action,
  ops,
}: ScalingTabProps) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Zap size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Replica state</h3>
          <span className="ml-auto font-mono text-[9px] text-muted">
            {replicas.filter((replica) => replica.status !== "stopped").length} running · desired {app.desired_replicas ?? 1}
          </span>
        </div>
        {app.status === "sleeping" && (
          <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
            <Btn
              size="sm"
              variant="primary"
              loading={actionLoading === "wake" || ops.isBusyWith("wake")}
              disabled={ops.isBusy}
              onClick={() => action("wake", () => post(`/api/apps/${appId}/wake`))}
            >
              Wake app
            </Btn>
          </PermissionGate>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Gauge size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Autoscale policy</h3>
          <span className={`ml-auto border-2 border-fg px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${app.autoscale_enabled ? "bg-accent text-fg" : "bg-alt text-muted"}`}>
            {app.autoscale_enabled ? "Active" : "Off"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[10px] sm:grid-cols-3">
          <div><span className="text-muted">Min</span><div className="text-fg">{app.min_replicas ?? 1}</div></div>
          <div><span className="text-muted">Max</span><div className="text-fg">{app.max_replicas ?? 1}</div></div>
          <div><span className="text-muted">CPU</span><div className="text-fg">{app.autoscale_cpu_threshold ?? 80}%</div></div>
          <div><span className="text-muted">Memory</span><div className="text-fg">{app.autoscale_mem_threshold ?? 85}%</div></div>
          <div><span className="text-muted">Requests/min</span><div className="text-fg">{app.autoscale_req_threshold ?? 0}</div></div>
          <div><span className="text-muted">Cooldown</span><div className="text-fg">{app.autoscale_cooldown ?? 300}s</div></div>
        </div>
      </Card>

      {scalingEvents.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <History size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Recent scaling events</h3>
          </div>
          <Table headers={["When", "Event", "From → To", "Reason"]}>
            {scalingEvents.slice(0, 20).map((event) => (
              <tr key={event.id}>
                <td className="px-3 py-2 text-[9px] text-muted">{new Date(`${event.created_at}Z`).toLocaleString()}</td>
                <td className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-fg">{event.event_type}</td>
                <td className="px-3 py-2 text-fg-dim">{event.from_count} → {event.to_count}</td>
                <td className="px-3 py-2 text-[9px] text-fg-dim">{event.reason || "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
