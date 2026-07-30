import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, Checkbox, Spinner, Table, Field, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Zap, Gauge, History } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import { trackOperationInToast, humanizeStep, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, ScalingEvent } from "../../types.ts";

interface ScalingPolicy {
  autoscale_enabled: boolean;
  min_replicas: number;
  max_replicas: number;
  cpu_threshold: number;
  mem_threshold: number;
  cooldown: number;
  scale_to_zero_after: number;
  req_threshold: number;
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
  // Request-rate scaling needs Traefik request counters, which only exist for
  // HTTP-routed apps (raw-TCP apps have none). Matches the engine predicate.
  const httpRouted = app.internal_protocol !== "tcp";
  const volumeLockedReason = "Apps with persistent storage cannot scale above 1 replica; a cloud volume can only be attached to a single server at a time.";
  const runScale = async (target: number): Promise<void> => {
    const res = (app.status === "sleeping" || app.status === "waking") && target >= 1
      ? (await post(`/api/apps/${appId}/wake`)) as { op_id: number | null }
      : (await post("/api/apps/deploy", {
          app_name: app.name,
          apply_mode: "patch",
          deploy: false,
          replicas: target,
        })) as { op_id: number | null };

    // Waking a sleeping app still runs as a tracked operation.
    if (res.op_id) {
      ops.track(res.op_id);
      const terminal = await trackOperationInToast(res.op_id, "Waking app");
      if (terminal && terminal !== "done" && terminal !== "cancelled") {
        throw new Error(ops.latest?.error?.message || "Wake failed");
      }
      await loadReplicas();
      await load();
      return;
    }

    // Level-triggered scaling: the API only records desired_replicas; the
    // reconciler converges the live replica set within a tick (≤30s). There is
    // no op to track, so poll the replica list until it reflects the target.
    await load(); // surface the new desired_replicas immediately
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const reps = (await get(`/api/apps/${appId}/replicas`)) as ReplicaData[];
      // A scale-to-zero leaves one stopped "sleep anchor" row, so count only
      // live replicas when checking convergence.
      const running = reps.filter((r) => r.status !== "stopped").length;
      if (target === 0 ? running === 0 : running === target) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await loadReplicas();
    await load();
  };

  // Wake is the only remaining scaling operation; up/down/sleep are now
  // level-triggered (reconciler-driven) and have no op to track.
  const SCALING_KINDS = ["wake"];
  const scalingOp = ops.active.find((o) => SCALING_KINDS.includes(o.kind)) || null;
  const progressMessage = scalingOp ? humanizeStep(scalingOp.last_step) || "Starting..." : "";
  const showProgress = !!progressMessage;
  return (
    <div className="space-y-4">
      {!app.public && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-muted flex items-center gap-1">Private app; no public wake page. <InfoTip text="A sleeping private app has no public URL to wake it on request; wake it from this dashboard, the CLI, or the API." /></p>
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
              {app.status === "sleeping" ? "sleeping" : ""}
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
        <PermissionGate permission="apps.deploy" appId={appId} environmentId={app.environment_id}>
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
                    : "This will sleep the app. Private apps have no public wake page; wake it from this dashboard, the CLI, or the API.";
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
              <InfoTip text="Reconciler checks CPU/memory (and request rate for HTTP apps) every 30s and scales between min and max replicas." />
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
              <Field label={<span className="flex items-center gap-1">CPU % <InfoTip text="Average CPU use as a percent of the app's CPU limit (--cpus), not the whole server. Above this triggers scale-up; the autoscaler scales down proportionally when it drops below." /></span>}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.cpu_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, cpu_threshold: parseInt(e.target.value) || 0 })}
                />
              </Field>
              <Field label={<span className="flex items-center gap-1">Mem % <InfoTip text="Average memory use as a percent of the app's memory limit, not the whole server. Above this triggers scale-up; the autoscaler scales down proportionally when it drops below." /></span>}>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={policy.mem_threshold}
                  disabled={!policy.autoscale_enabled}
                  onChange={(e) => setPolicy({ ...policy, mem_threshold: parseInt(e.target.value) || 0 })}
                />
              </Field>
              {httpRouted && (
                <Field label={<span className="flex items-center gap-1">Req/min <InfoTip text="Target requests/min per replica (HTTP apps only). Scales up when average traffic per replica exceeds this; an HPA-style signal alongside CPU/memory, whichever demands more replicas wins. 0 disables request-based scaling." /></span>}>
                  <input
                    type="number"
                    min={0}
                    value={policy.req_threshold}
                    disabled={!policy.autoscale_enabled}
                    onChange={(e) => setPolicy({ ...policy, req_threshold: parseInt(e.target.value) || 0 })}
                  />
                </Field>
              )}
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

            <PermissionGate permission="apps.deploy" appId={appId} environmentId={app.environment_id}>
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "policy"}
                  onClick={() => action("policy", async () => {
                    await post("/api/apps/deploy", {
                      app_name: app.name,
                      apply_mode: "patch",
                      deploy: false,
                      autoscale_enabled: policy.autoscale_enabled,
                      min_replicas: policy.min_replicas,
                      max_replicas: policy.max_replicas,
                      autoscale_cpu_threshold: policy.cpu_threshold,
                      autoscale_mem_threshold: policy.mem_threshold,
                      autoscale_req_threshold: policy.req_threshold,
                      autoscale_cooldown: policy.cooldown,
                      scale_to_zero_after: policy.scale_to_zero_after,
                    });
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
