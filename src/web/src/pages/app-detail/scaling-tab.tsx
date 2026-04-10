import { post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Zap, Gauge } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import type { AppData, ReplicaData } from "../../types.ts";

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
  policy: ScalingPolicy | null;
  setPolicy: (p: ScalingPolicy) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  loadReplicas: () => Promise<void>;
  load: () => Promise<void>;
}

export function ScalingTab({ app, appId, replicas, policy, setPolicy, actionLoading, action, loadReplicas, load }: ScalingTabProps) {
  return (
    <div className="space-y-4">
      {(!app.domain || app.domain.endsWith(".nip.io")) && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-accent-amber font-bold">Scaling requires a custom domain. Add a domain in Settings first — nip.io URLs are tied to a single server IP and cannot be load-balanced.</p>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Manual Scaling</h3>
          <span className="ml-auto font-mono text-[9px] text-muted uppercase tracking-wider">
            {replicas.length} running · desired {app.desired_replicas ?? replicas.length}
          </span>
        </div>

        {replicas.length > 0 ? (
          <div className="flex gap-1 mb-4">
            {Array.from({ length: replicas.length }).map((_, i) => (
              <div key={i} className="flex-1 h-8 border-2 border-fg bg-accent shadow-neo-sm" />
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider mb-4">
            {app.status === "sleeping" ? "No replicas — app is sleeping. Wakes automatically on HTTP request." : "No replicas"}
          </p>
        )}

        <PermissionGate permission="scaling.manage">
          <div className="flex justify-end gap-2">
            {app.status === "sleeping" && (
              <Btn
                size="sm"
                loading={actionLoading === "wake"}
                onClick={() => action("wake", async () => {
                  await post(`/api/apps/${appId}/scale`, { replicas: 1 });
                  await loadReplicas();
                  await load();
                })}
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
                  if (!await confirm("Scale to Zero", "This will sleep the app. It wakes automatically when it receives an HTTP request.")) return;
                }
                await post(`/api/apps/${appId}/scale`, { replicas: current - 1 });
                await loadReplicas();
                await load();
              })}
            >–</Btn>
            <Btn
              size="sm"
              loading={actionLoading === "scale-up"}
              disabled={!app.domain || app.domain.endsWith(".nip.io")}
              title={!app.domain || app.domain.endsWith(".nip.io") ? "Add a custom domain to enable scaling" : "Add one replica. Placement is automatic: reuse a ready server with no replica of this app, or provision a new one."}
              onClick={() => action("scale-up", async () => {
                const current = replicas.length || app.desired_replicas || 1;
                await post(`/api/apps/${appId}/scale`, { replicas: current + 1 });
                await loadReplicas();
              })}
            >+</Btn>
          </div>
        </PermissionGate>
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
                checked={policy.autoscale_enabled && !(!app.domain || app.domain.endsWith(".nip.io"))}
                onChange={(v) => {
                  if (!app.domain || app.domain.endsWith(".nip.io")) return;
                  setPolicy({ ...policy, autoscale_enabled: v });
                }}
                label="Enable autoscaling"
              />
              <InfoTip text="Reconciler checks CPU/memory every 30s and scales between min and max replicas." />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Min <InfoTip text="Lowest replica count the autoscaler is allowed to scale down to. Set to 0 to enable scale-to-zero (app sleeps when idle, wakes on HTTP request)." /></label>
                <input
                  type="number"
                  min={0}
                  value={policy.min_replicas}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, min_replicas: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Max <InfoTip text="Highest replica count the autoscaler will scale up to." /></label>
                <input
                  type="number"
                  min={1}
                  value={policy.max_replicas}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, max_replicas: parseInt(e.target.value) || 1 })}
                />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">CPU % <InfoTip text="Average CPU above this triggers scale-up. Scale-down kicks in below half this value." /></label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.cpu_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, cpu_threshold: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Mem % <InfoTip text="Average memory above this triggers scale-up. Scale-down kicks in below half this value." /></label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.mem_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, mem_threshold: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Cooldown s <InfoTip text="Minimum seconds between scaling actions to prevent flapping." /></label>
                <input
                  type="number"
                  min={30}
                  value={policy.cooldown}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, cooldown: parseInt(e.target.value) || 30 })}
                />
              </div>
              {policy.min_replicas === 0 && (
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Idle timeout s <InfoTip text="Seconds of sustained low CPU/memory before the app sleeps. The app wakes automatically on the next HTTP request." /></label>
                  <input
                    type="number"
                    min={60}
                    value={policy.scale_to_zero_after}
                    disabled={!policy.autoscale_enabled}
                    onChange={(e) => setPolicy({ ...policy, scale_to_zero_after: parseInt(e.target.value) || 300 })}
                  />
                </div>
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
    </div>
  );
}
