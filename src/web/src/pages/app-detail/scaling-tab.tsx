import { useEffect, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, Spinner, Table, Field, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { Zap, Gauge, History } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import { trackOperationInToast, humanizeStep, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, ScalingEvent, ResourceServer } from "../../types.ts";

interface ScalingPolicy {
  autoscale_enabled: boolean;
  min_replicas: number;
  max_replicas: number;
  cpu_threshold: number;
  mem_threshold: number;
  cooldown: number;
  scale_to_zero_after: number;
}

interface ScalingTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  scalingEvents: ScalingEvent[];
  policy: ScalingPolicy | null;
  setPolicy: (p: ScalingPolicy) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  loadReplicas: () => Promise<void>;
  load: () => Promise<void>;
  ops: ResourceOpsResult;
}

export function ScalingTab({ app, appId, replicas, scalingEvents, policy, setPolicy, actionLoading, action, loadReplicas, load, ops }: ScalingTabProps) {
  const hasVolume = Boolean(app.volume_id);
  const volumeLockedReason = "Apps with persistent storage cannot scale above 1 replica — a cloud volume can only be attached to a single server at a time.";
  // No custom-domain requirement: the panel is the sole public ingress and
  // load-balances across replicas over the private network, so nip.io
  // auto-domains scale just like custom domains. Only volumes lock an app to
  // a single replica.
  const [selectedServer, setSelectedServer] = useState<string>("");
  const [servers, setServers] = useState<ResourceServer[]>([]);

  // Fetch available servers for the server picker
  useEffect(() => {
    get("/api/resources")
      .then((res: any) => {
        setServers((res.servers || []).filter((s: any) => s.status === "ready"));
      })
      .catch(() => {});
  }, []);

  const runScale = async (target: number): Promise<void> => {
    const body: { replicas: number; server_id?: number } = { replicas: target };
    if (selectedServer) body.server_id = parseInt(selectedServer, 10);
    const res = (await post(`/api/apps/${appId}/scale`, body)) as { op_id: number | null; noop?: boolean };
    if (!res.op_id) {
      await loadReplicas();
      await load();
      return;
    }
    ops.track(res.op_id);
    const terminal = await trackOperationInToast(
      res.op_id,
      target === 0 ? "Sleeping app" : target > replicas.length ? "Scaling up" : "Scaling down",
    );
    if (terminal && terminal !== "done" && terminal !== "cancelled") {
      throw new Error(ops.latest?.error?.message || "Scaling failed");
    }
    await loadReplicas();
    await load();
  };

  const SCALING_KINDS = ["scale_up", "scale_down", "wake", "sleep"];
  const scalingOp = ops.active.find((o) => SCALING_KINDS.includes(o.kind)) || null;
  const progressMessage = scalingOp ? humanizeStep(scalingOp.last_step) || "Starting..." : "";
  const showProgress = !!progressMessage;
  return (
    <div className="space-y-4">
      {!app.public && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-muted flex items-center gap-1">Private app — no public wake page. <InfoTip text="A sleeping private app has no public URL to wake it on request; wake it from this dashboard, the CLI, or the API." /></p>
        </Card>
      )}

      {hasVolume && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-accent-amber font-bold flex items-center gap-1">Volumes lock this app to 1 replica. <InfoTip text="A cloud volume can only be attached to a single server at a time." /></p>
        </Card>
      )}

      <Card className="p-3">
        <div className="flex items-center gap-2">
          <Zap size={12} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Manual Scaling</h3>
          <span className="font-mono text-[9px] text-muted uppercase tracking-wider">
            {replicas.length} running · desired {app.desired_replicas ?? replicas.length}
          </span>

          {replicas.length === 0 && (
            <span className="font-mono text-[9px] text-muted ml-1">
              {app.status === "sleeping" ? "— sleeping" : ""}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {replicas.length > 0 && (
              <div className="flex gap-0.5 mr-2">
                {Array.from({ length: replicas.length }).map((_, i) => (
                  <div key={i} className="w-3 h-3 border border-fg bg-accent" />
                ))}
              </div>
            )}
            {servers.length >= 2 && (
              <div className="w-36 mr-1">
                <NeoSelect
                  value={selectedServer}
                  onChange={setSelectedServer}
                  options={[
                    { value: "", label: "Auto" },
                    ...servers.map((s) => ({
                      value: String(s.id),
                      label: `${s.name.replace(/^ocd-/, "")} ${s.cpu_percent != null ? `${s.cpu_percent}%` : ""}`,
                    })),
                  ]}
                  compact
                />
              </div>
            )}
        <PermissionGate permission="scaling.manage">
          <div className="flex gap-1">
            {app.status === "sleeping" && (
              <Btn
                size="sm"
                loading={actionLoading === "wake"}
                onClick={() => action("wake", () => runScale(1))}
              >Wake</Btn>
            )}
            <Btn
              size="sm"
              variant="ghost"
              disabled={replicas.length < 1}
              loading={actionLoading === "scale-down"}
              title="Remove one replica"
              onClick={() => action("scale-down", async () => {
                const current = replicas.length || app.desired_replicas || 1;
                if (current < 1) return;
                if (current === 1) {
                  const msg = app.public
                    ? "This will sleep the app. It wakes automatically when it receives an HTTP request."
                    : "This will sleep the app. Private apps have no public wake page — wake it from this dashboard, the CLI, or the API.";
                  if (!await confirm("Scale to Zero", msg)) return;
                }
                await runScale(current - 1);
              })}
            >–</Btn>
            <Btn
              size="sm"
              loading={actionLoading === "scale-up"}
              disabled={hasVolume}
              title={
                hasVolume
                  ? volumeLockedReason
                  : "Add one replica. Placement is automatic: reuse a ready server with no replica of this app, or provision a new one."
              }
              onClick={() => action("scale-up", async () => {
                const current = replicas.length || app.desired_replicas || 1;
                if (hasVolume && current >= 1) return;
                await runScale(current + 1);
              })}
            >+</Btn>
          </div>
        </PermissionGate>
          </div>
        </div>

        {showProgress && (
          <div className="mt-2 flex items-center gap-2 px-3 py-1.5 border-2 border-fg bg-alt">
            <Spinner />
            <span className="font-mono text-[10px] text-fg uppercase tracking-wider truncate">{progressMessage}</span>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Autoscale Policy</h3>
          <span className={`ml-auto font-mono text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 border-2 border-fg ${policy?.autoscale_enabled ? "bg-accent text-fg" : "bg-alt text-muted"}`}>
            {policy?.autoscale_enabled ? "Active" : "Off"}
          </span>
        </div>

        {policy && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={policy.autoscale_enabled}
                onChange={(v) => {
                  setPolicy({ ...policy, autoscale_enabled: v });
                }}
                label="Enable autoscaling"
              />
              <InfoTip text="Reconciler checks CPU/memory every 30s and scales between min and max replicas." />
            </div>

            <div>
              <Field label={<span className="flex items-center gap-1">Min <InfoTip text="Lowest replica count the autoscaler is allowed to scale down to. Set to 0 to enable scale-to-zero (app sleeps when idle, wakes on HTTP request)." /></span>}>
                <input
                  type="number"
                  min={0}
                  value={policy.min_replicas}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, min_replicas: parseInt(e.target.value) || 0 })}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1">Max <InfoTip text={hasVolume ? volumeLockedReason : "Highest replica count the autoscaler will scale up to."} /></span>}>
                <input
                  type="number"
                  min={1}
                  max={hasVolume ? 1 : undefined}
                  value={hasVolume ? 1 : policy.max_replicas}
                  disabled={!policy.autoscale_enabled || hasVolume}
                  title={hasVolume ? volumeLockedReason : undefined}
                  onChange={(e) => setPolicy({ ...policy, max_replicas: parseInt(e.target.value) || 1 })}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1">CPU % <InfoTip text="Average CPU above this triggers scale-up. Scale-down kicks in below half this value." /></span>}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.cpu_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, cpu_threshold: parseInt(e.target.value) || 0 })}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1">Mem % <InfoTip text="Average memory above this triggers scale-up. Scale-down kicks in below half this value." /></span>}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.mem_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, mem_threshold: parseInt(e.target.value) || 0 })}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1">Cooldown s <InfoTip text="Minimum seconds between scaling actions to prevent flapping." /></span>}>
                <input
                  type="number"
                  min={30}
                  value={policy.cooldown}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, cooldown: parseInt(e.target.value) || 30 })}
                />
              </Field>
              {policy.min_replicas === 0 && (
                <Field label={<span className="flex items-center gap-1">Idle timeout s <InfoTip text="Seconds of sustained low CPU/memory before the app sleeps. The app wakes automatically on the next HTTP request." /></span>}>
                  <input
                    type="number"
                    min={60}
                    value={policy.scale_to_zero_after}
                    disabled={!policy.autoscale_enabled}
                    onChange={(e) => setPolicy({ ...policy, scale_to_zero_after: parseInt(e.target.value) || 300 })}
                  />
                </Field>
              )}
            </div>

            <PermissionGate permission="scaling.manage">
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "policy"}
                  onClick={() => action("policy", async () => {
                    await put(`/api/apps/${appId}/scaling-policy`, policy);
                    await load();
                  })}
                >Save Policy</Btn>
              </div>
            </PermissionGate>
          </div>
        )}
      </Card>

      {scalingEvents.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <History size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Recent Scaling Events</h3>
          </div>
          <Table headers={["When", "Event", "From → To", "Reason"]}>
            {scalingEvents.slice(0, 20).map((e) => (
              <tr key={e.id}>
                <td className="py-2 px-3 text-muted text-[9px]">{new Date(e.created_at + "Z").toLocaleString()}</td>
                <td className="py-2 px-3 text-fg font-bold text-[9px] uppercase tracking-wider">{e.event_type}</td>
                <td className="py-2 px-3 text-fg-dim">{e.from_count} → {e.to_count}</td>
                <td className="py-2 px-3 text-fg-dim text-[9px]">{e.reason || "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
