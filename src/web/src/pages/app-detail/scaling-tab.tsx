import { useEffect, useRef, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, Spinner, Table, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { Zap, Gauge, History } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import type { AppData, ReplicaData, ScalingEvent, ResourceServer } from "../../types.ts";

type ScaleJobPoll = {
  status: "running" | "done" | "error";
  events: Array<{ seq: number; ts: string; step: string; detail: string }>;
  last_seq: number;
  result: { ok: boolean; error?: string } | null;
};

// Long-polls /api/deploy-jobs/:id (the existing job-poll endpoint) until the
// scale job finishes. Pumps each new event's detail into onProgress so the
// UI can show what's happening live. Throws on job error so the calling
// `action` wrapper surfaces it as a toast.
async function pollScaleJob(
  jobId: number,
  onProgress: (msg: string) => void,
  alive: { current: boolean },
): Promise<void> {
  let since = 0;
  while (alive.current) {
    let resp: ScaleJobPoll;
    try {
      resp = (await get(`/api/deploy-jobs/${jobId}?since=${since}`)) as ScaleJobPoll;
    } catch {
      // Transient network blip — back off briefly and retry. The server
      // long-poll already blocks up to 25s per request so this loop is cheap.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!alive.current) return;
    if (resp.events.length > 0) {
      const latest = resp.events[resp.events.length - 1];
      onProgress(latest.detail || latest.step);
      since = resp.last_seq;
    }
    if (resp.status !== "running") {
      if (resp.result && !resp.result.ok) {
        throw new Error(resp.result.error || "Scaling failed");
      }
      return;
    }
  }
}

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
}

export function ScalingTab({ app, appId, replicas, scalingEvents, policy, setPolicy, actionLoading, action, loadReplicas, load }: ScalingTabProps) {
  const hasVolume = Boolean(app.volume_id);
  const volumeLockedReason = "Apps with persistent storage cannot scale above 1 replica — a cloud volume can only be attached to a single server at a time.";
  const [progressMessage, setProgressMessage] = useState<string>("");
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

  // Tracks whether the component is still mounted, so the long-poll loop can
  // bail out if the user switches tabs mid-scale (the server-side scale keeps
  // running regardless — they just stop watching it).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  // Clear the progress text once the action wrapper releases its lock, so
  // stale "Re-binding container..." doesn't linger after success/failure.
  useEffect(() => {
    if (actionLoading === null) setProgressMessage("");
  }, [actionLoading]);

  const runScale = async (target: number): Promise<void> => {
    setProgressMessage("Starting...");
    const body: { replicas: number; server_id?: number } = { replicas: target };
    if (selectedServer) body.server_id = parseInt(selectedServer, 10);
    const res = (await post(`/api/apps/${appId}/scale`, body)) as { deployment_id: number };
    await pollScaleJob(res.deployment_id, setProgressMessage, aliveRef);
    await loadReplicas();
    await load();
  };

  const showProgress =
    (actionLoading === "scale-up" || actionLoading === "scale-down" || actionLoading === "wake") && !!progressMessage;
  return (
    <div className="space-y-4">
      {(!app.domain || app.domain.endsWith(".nip.io")) && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-accent-amber font-bold">Scaling requires a custom domain. Add a domain in Settings first — nip.io URLs are derived from a single server IP and can't be used once replicas are spread across multiple hosts.</p>
        </Card>
      )}

      {hasVolume && (
        <Card className="p-4">
          <p className="font-mono text-[10px] text-accent-amber font-bold">{volumeLockedReason}</p>
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
                  if (!await confirm("Scale to Zero", "This will sleep the app. It wakes automatically when it receives an HTTP request.")) return;
                }
                await runScale(current - 1);
              })}
            >–</Btn>
            <Btn
              size="sm"
              loading={actionLoading === "scale-up"}
              disabled={!app.domain || app.domain.endsWith(".nip.io") || hasVolume || replicas.length >= 1 && hasVolume}
              title={
                hasVolume
                  ? volumeLockedReason
                  : (!app.domain || app.domain.endsWith(".nip.io"))
                    ? "Add a custom domain to enable scaling"
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
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1 flex items-center gap-1">Max <InfoTip text={hasVolume ? volumeLockedReason : "Highest replica count the autoscaler will scale up to."} /></label>
                <input
                  type="number"
                  min={1}
                  max={hasVolume ? 1 : undefined}
                  value={hasVolume ? 1 : policy.max_replicas}
                  disabled={!policy.autoscale_enabled || hasVolume}
                  title={hasVolume ? volumeLockedReason : undefined}
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
