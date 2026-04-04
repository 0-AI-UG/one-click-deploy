import { useState, useEffect, useRef } from "react";
import { request } from "../rpc.ts";
import type { ServerWithApps, App, DeploymentRecord, Replica, ScalingEvent } from "../../shared/rpc.ts";
import { useConfirmAction } from "../hooks.ts";

export function ServerGrid({
  servers,
  onChanged,
  onViewLogs,
}: {
  servers: ServerWithApps[];
  onChanged: () => void;
  onViewLogs: (app: App) => void;
}) {
  const allApps = servers.flatMap(s => s.apps.map(a => ({ ...a, server: s })));

  return (
    <div>
      <div className="stamp" style={{ marginBottom: 8 }}>Your Apps</div>

      {allApps.length === 0 ? (
        <div className="card" style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 2 }}>No apps deployed yet</div>
          <div style={{ fontSize: 11, color: 'var(--fg-faint)' }}>Deploy your first app above</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {allApps.map(app => (
            <AppCard key={app.id} app={app} serverName={app.server.name} onChanged={onChanged} onViewLogs={onViewLogs} />
          ))}
        </div>
      )}

    </div>
  );
}


function AppCard({ app, serverName, onChanged, onViewLogs }: { app: App; serverName: string; onChanged: () => void; onViewLogs: (app: App) => void }) {
  const remove = useConfirmAction(async () => {
    await request.destroyApp({ app_id: app.id });
    onChanged();
  });

  const restart = useConfirmAction(async () => {
    await request.restartApp({ app_id: app.id });
    onChanged();
  });

  const pause = useConfirmAction(async () => {
    if (app.status === "paused") {
      await request.unpauseApp({ app_id: app.id });
    } else {
      await request.pauseApp({ app_id: app.id });
    }
    onChanged();
  });

  const [showRedeploy, setShowRedeploy] = useState(false);
  const [redeployEnv, setRedeployEnv] = useState("");
  const [redeployAuthEnabled, setRedeployAuthEnabled] = useState(false);
  const [redeployAuthPassword, setRedeployAuthPassword] = useState("");
  const [redeployBusy, setRedeployBusy] = useState(false);

  const openRedeploy = () => {
    const env = JSON.parse(app.env_vars || "{}") as Record<string, string>;
    setRedeployEnv(Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setRedeployAuthEnabled(!!app.auth_password);
    setRedeployAuthPassword(app.auth_password || "");
    setShowRedeploy(true);
  };

  const doRedeploy = async () => {
    setRedeployBusy(true);
    const env: Record<string, string> = {};
    for (const line of redeployEnv.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
    }
    const authPassword = redeployAuthEnabled && redeployAuthPassword ? redeployAuthPassword : null;
    await request.redeployApp({ app_id: app.id, env_vars: env, auth_password: authPassword });
    setRedeployBusy(false);
    setShowRedeploy(false);
    onChanged();
  };

  const [showHistory, setShowHistory] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);

  // Scaling state
  const [showScale, setShowScale] = useState(false);
  const [replicas, setReplicas] = useState<Replica[]>([]);
  const [scalingEvents, setScalingEvents] = useState<ScalingEvent[]>([]);
  const [scaleTarget, setScaleTarget] = useState(String(app.desired_replicas || 1));
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleError, setScaleError] = useState("");
  const [autoScaleEnabled, setAutoScaleEnabled] = useState(!!app.autoscale_enabled);
  const [cpuThreshold, setCpuThreshold] = useState(String(app.autoscale_cpu_threshold || 80));
  const [memThreshold, setMemThreshold] = useState(String(app.autoscale_mem_threshold || 85));
  const [minReplicas, setMinReplicas] = useState(String(app.min_replicas || 1));
  const [maxReplicas, setMaxReplicas] = useState(String(app.max_replicas || 1));
  const [showEvents, setShowEvents] = useState(false);

  const anyBusy = remove.busy || restart.busy || pause.busy || redeployBusy || actionBusy || webhookBusy || scaleBusy;

  const statusLabel =
    app.status === "running" ? "Online" :
    app.status === "deploying" ? "Starting..." :
    app.status === "paused" ? "Paused" :
    app.status === "unhealthy" ? "Unhealthy" :
    app.status === "error" ? "Error" : "Stopped";

  const statusDot =
    app.status === "running" ? "dot-ok" :
    app.status === "deploying" ? "dot-warn" :
    app.status === "paused" ? "dot-off" :
    app.status === "unhealthy" ? "dot-warn" :
    app.status === "error" ? "dot-err" : "dot-off";

  const toggleHistory = async () => {
    if (!showHistory) {
      setShowHistory(true);
      const deps = await request.getDeployments({ app_id: app.id });
      setDeployments(deps);
    } else {
      setShowHistory(false);
    }
  };

  const handleRollback = async (deploymentId: number) => {
    setActionBusy(true);
    await request.rollbackApp({ app_id: app.id, deployment_id: deploymentId });
    setActionBusy(false);
    onChanged();
  };

  const toggleWebhook = async () => {
    setWebhookBusy(true);
    if (app.webhook_enabled) {
      await request.disableWebhook({ app_id: app.id });
    } else {
      await request.enableWebhook({ app_id: app.id });
    }
    setWebhookBusy(false);
    onChanged();
  };

  const openScale = async () => {
    if (showScale) {
      setShowScale(false);
      return;
    }
    setShowScale(true);
    const [reps, evts] = await Promise.all([
      request.getReplicas({ app_id: app.id }),
      request.getScalingEvents({ app_id: app.id }),
    ]);
    setReplicas(reps);
    setScalingEvents(evts);
    setScaleTarget(String(app.desired_replicas || reps.length || 1));
  };

  const [scaleConfirmArmed, setScaleConfirmArmed] = useState(false);
  const scaleConfirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const doScale = async () => {
    const target = parseInt(scaleTarget, 10);
    if (isNaN(target) || target < 1 || scaleBusy) return;

    // If scaling up, require double-click confirmation
    if (target > (app.desired_replicas || 1) && !scaleConfirmArmed) {
      setScaleConfirmArmed(true);
      clearTimeout(scaleConfirmTimer.current);
      scaleConfirmTimer.current = setTimeout(() => setScaleConfirmArmed(false), 3000);
      return;
    }
    setScaleConfirmArmed(false);
    clearTimeout(scaleConfirmTimer.current);

    setScaleBusy(true);
    setScaleError("");
    try {
      const result = await request.scaleApp({ app_id: app.id, replicas: target });
      if (!result.ok) {
        setScaleError(result.error || "Scale operation failed");
      }
      onChanged();
      const reps = await request.getReplicas({ app_id: app.id });
      setReplicas(reps);
    } catch (err: any) {
      setScaleError(err.message || String(err));
    }
    setScaleBusy(false);
  };

  const saveScalingPolicy = async () => {
    setScaleBusy(true);
    await request.updateScalingPolicy({
      app_id: app.id,
      min_replicas: parseInt(minReplicas, 10) || 1,
      max_replicas: parseInt(maxReplicas, 10) || 1,
      autoscale_enabled: autoScaleEnabled,
      cpu_threshold: parseInt(cpuThreshold, 10) || 80,
      mem_threshold: parseInt(memThreshold, 10) || 85,
    });
    setScaleBusy(false);
    onChanged();
  };

  const refreshMetrics = async () => {
    const reps = await request.getAppMetrics({ app_id: app.id });
    setReplicas(reps);
  };

  // Auto-refresh metrics when scale panel is open
  useEffect(() => {
    if (!showScale) return;
    const interval = setInterval(refreshMetrics, 15_000);
    return () => clearInterval(interval);
  }, [showScale]);

  const replicaCount = app.desired_replicas || 1;
  const healthyCount = replicas.filter(r => r.status === "running").length;
  const isScaled = replicaCount > 1;

  return (
    <div className="card" style={{ padding: 10, opacity: anyBusy ? 0.4 : 1 }}>
      {/* Top row: name + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div className={`dot ${statusDot}`} />
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{app.name}</span>
        <span className="mono" style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.04em',
          color: app.status === "running" ? 'var(--fg)' : app.status === "error" ? 'var(--red)' : app.status === "unhealthy" ? 'var(--amber)' : 'var(--fg-faint)',
        }}>
          {statusLabel}
        </span>
      </div>

      {/* Domain link */}
      <button
        onClick={() => request.openExternal({ url: `https://${app.domain}` })}
        className="tag"
        style={{
          background: 'var(--accent)', color: 'var(--fg)', cursor: 'pointer',
          fontSize: 9, padding: '2px 6px', marginBottom: 6, display: 'inline-flex', gap: 3,
          border: '1.5px solid var(--fg)',
        }}
      >
        {app.domain}
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
      {app.deploy_mode === "compose" && (
        <span className="mono" style={{
          fontSize: 8, fontWeight: 700, letterSpacing: '.04em',
          padding: '1px 5px', marginLeft: 4, marginBottom: 6, display: 'inline-block',
          background: 'var(--bg-alt)', border: '1px solid var(--fg)', color: 'var(--fg-dim)',
        }}>
          COMPOSE
        </span>
      )}
      {isScaled && (
        <span className="mono" style={{
          fontSize: 8, fontWeight: 700, letterSpacing: '.04em',
          padding: '1px 5px', marginLeft: 4, marginBottom: 6, display: 'inline-block',
          border: '1px solid var(--fg)',
          background: healthyCount === replicaCount ? 'var(--accent)' :
            healthyCount > replicaCount / 2 ? 'var(--amber)' : 'var(--red)',
          color: healthyCount === replicaCount ? 'var(--fg)' : '#fff',
        }}>
          {healthyCount}/{replicaCount} REPLICAS
        </span>
      )}

      {/* Action buttons row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        <button onClick={() => onViewLogs(app)} className="act" disabled={anyBusy}>
          Logs
        </button>
        <button
          onClick={restart.click}
          disabled={anyBusy}
          className="act"
          style={{ color: restart.armed ? 'var(--amber)' : undefined }}
        >
          {restart.armed ? 'Confirm?' : 'Restart'}
        </button>
        <button
          onClick={pause.click}
          disabled={anyBusy}
          className="act"
          style={{ color: pause.armed ? 'var(--amber)' : undefined }}
        >
          {pause.armed ? 'Confirm?' : app.status === "paused" ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => showRedeploy ? setShowRedeploy(false) : openRedeploy()}
          disabled={anyBusy}
          className="act"
          style={{ color: showRedeploy ? 'var(--amber)' : undefined }}
        >
          {showRedeploy ? '− Redeploy' : 'Redeploy'}
        </button>
        <button onClick={toggleHistory} className="act" disabled={anyBusy}>
          {showHistory ? '− History' : '+ History'}
        </button>
        <button
          onClick={toggleWebhook}
          disabled={anyBusy}
          className="act"
          style={{ color: app.webhook_enabled ? 'var(--accent)' : undefined }}
        >
          {webhookBusy ? '...' : app.webhook_enabled ? '− Webhook' : '+ Webhook'}
        </button>
        <button
          onClick={openScale}
          disabled={anyBusy}
          className="act"
          style={{ color: showScale ? 'var(--amber)' : isScaled ? 'var(--accent)' : undefined }}
        >
          {showScale ? '− Scale' : '+ Scale'}
        </button>
      </div>

      {/* Webhook status indicator */}
      {!!app.webhook_enabled && (
        <div className="mono" style={{
          fontSize: 8, fontWeight: 700, letterSpacing: '.06em',
          color: 'var(--fg-dim)', marginBottom: 6,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{ color: 'var(--accent)' }}>AUTO-DEPLOY</span>
          <span style={{ color: 'var(--fg-faint)' }}>on {app.webhook_branch || 'main'}</span>
        </div>
      )}

      {/* Scale panel */}
      {showScale && (
        <div style={{ marginBottom: 6 }}>
          {/* Manual scale controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span className="mono" style={{ fontSize: 9, fontWeight: 600, flex: 'none' }}>Replicas</span>
            <input
              type="number"
              value={scaleTarget}
              onChange={e => setScaleTarget(e.target.value)}
              min={1}
              max={10}
              className="inp"
              style={{ width: 50, flex: 'none', fontSize: 9, textAlign: 'center' }}
            />
            <button
              onClick={doScale}
              disabled={scaleBusy}
              className="btn"
              style={{
                fontSize: 8, padding: '4px 10px',
                background: scaleConfirmArmed ? 'var(--amber)' : undefined,
                color: scaleConfirmArmed ? 'var(--fg)' : undefined,
              }}
            >
              {scaleBusy ? 'Scaling...' : scaleConfirmArmed ? 'Confirm scale up?' : 'Apply'}
            </button>
          </div>

          {/* Scale error */}
          {scaleError && (
            <div className="mono" style={{
              fontSize: 9, fontWeight: 700, color: 'var(--red)',
              padding: '5px 8px', background: 'var(--red-dim)', border: '1.5px solid var(--red)',
              marginBottom: 6, wordBreak: 'break-word',
            }}>
              {scaleError}
            </div>
          )}

          {/* Auto-scale toggle */}
          <div style={{ padding: '6px 8px', background: 'var(--bg-alt)', border: '1px solid var(--fg)', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 1 }}>
                <input type="checkbox" checked={autoScaleEnabled} onChange={e => setAutoScaleEnabled(e.target.checked)} />
                <span className="mono" style={{ fontSize: 9, fontWeight: 700 }}>Auto-scale</span>
              </label>
            </div>
            {autoScaleEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginBottom: 2 }}>Min</div>
                    <input type="number" value={minReplicas} onChange={e => setMinReplicas(e.target.value)} min={1} max={10} className="inp" style={{ width: '100%', fontSize: 9, textAlign: 'center' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginBottom: 2 }}>Max</div>
                    <input type="number" value={maxReplicas} onChange={e => setMaxReplicas(e.target.value)} min={1} max={10} className="inp" style={{ width: '100%', fontSize: 9, textAlign: 'center' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginBottom: 2 }}>CPU %</div>
                    <input type="number" value={cpuThreshold} onChange={e => setCpuThreshold(e.target.value)} min={10} max={100} className="inp" style={{ width: '100%', fontSize: 9, textAlign: 'center' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginBottom: 2 }}>Mem %</div>
                    <input type="number" value={memThreshold} onChange={e => setMemThreshold(e.target.value)} min={10} max={100} className="inp" style={{ width: '100%', fontSize: 9, textAlign: 'center' }} />
                  </div>
                </div>
                <button onClick={saveScalingPolicy} disabled={scaleBusy} className="btn" style={{ width: '100%', fontSize: 8, padding: '3px 0' }}>
                  {scaleBusy ? 'Saving...' : 'Save Policy'}
                </button>
              </div>
            )}
          </div>

          {/* Per-replica metrics */}
          {replicas.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--fg-faint)', letterSpacing: '.06em', marginBottom: 3 }}>
                REPLICAS
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {replicas.map(r => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                    background: 'var(--bg-alt)', border: '1px solid var(--fg)', fontSize: 9,
                  }}>
                    <div className={`dot ${r.status === 'running' ? 'dot-ok' : r.status === 'draining' ? 'dot-warn' : 'dot-err'}`} />
                    <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.container_name}
                    </span>
                    <span className="mono" style={{ color: 'var(--fg-faint)', fontSize: 8, width: 40, textAlign: 'right' }}>
                      {r.cpu_percent.toFixed(0)}%
                    </span>
                    <div style={{ width: 40, height: 6, background: 'var(--bg)', border: '1px solid var(--fg)' }}>
                      <div style={{
                        width: `${Math.min(r.cpu_percent, 100)}%`, height: '100%',
                        background: r.cpu_percent > 80 ? 'var(--red)' : r.cpu_percent > 50 ? 'var(--amber)' : 'var(--accent)',
                      }} />
                    </div>
                    <span className="mono" style={{ color: 'var(--fg-faint)', fontSize: 8, width: 40, textAlign: 'right' }}>
                      {r.memory_percent.toFixed(0)}%
                    </span>
                    <div style={{ width: 40, height: 6, background: 'var(--bg)', border: '1px solid var(--fg)' }}>
                      <div style={{
                        width: `${Math.min(r.memory_percent, 100)}%`, height: '100%',
                        background: r.memory_percent > 85 ? 'var(--red)' : r.memory_percent > 60 ? 'var(--amber)' : 'var(--accent)',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scaling events */}
          <button onClick={() => setShowEvents(!showEvents)} className="act" style={{ fontSize: 8, marginBottom: 4 }}>
            {showEvents ? '− Events' : '+ Events'}
          </button>
          {showEvents && scalingEvents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {scalingEvents.slice(0, 10).map(evt => (
                <div key={evt.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px',
                  background: 'var(--bg-alt)', border: '1px solid var(--fg)', fontSize: 8,
                }}>
                  <span className="mono" style={{
                    fontWeight: 700,
                    color: evt.event_type.includes('up') ? 'var(--accent)' : 'var(--amber)',
                  }}>
                    {evt.event_type.includes('up') ? '▲' : '▼'} {evt.from_count}→{evt.to_count}
                  </span>
                  <span className="mono" style={{ flex: 1, color: 'var(--fg-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {evt.reason}
                  </span>
                  <span className="mono" style={{ color: 'var(--fg-faint)', flexShrink: 0 }}>
                    {new Date(evt.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Redeploy with env editor */}
      {showRedeploy && (
        <div style={{ marginBottom: 6 }}>
          <textarea
            className="inp mono"
            value={redeployEnv}
            onChange={e => setRedeployEnv(e.target.value)}
            placeholder={"KEY=value\nDB_URL=postgres://..."}
            rows={4}
            style={{
              width: '100%', fontSize: 9, resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
              marginBottom: 4,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 1 }}>
              <input type="checkbox" checked={redeployAuthEnabled} onChange={e => setRedeployAuthEnabled(e.target.checked)} />
              <span className="mono" style={{ fontSize: 9, fontWeight: 600 }}>Password protect</span>
            </label>
            {redeployAuthEnabled && (
              <input type="password" value={redeployAuthPassword} onChange={e => setRedeployAuthPassword(e.target.value)} placeholder="Password" className="inp" style={{ width: 120, flex: 'none', fontSize: 9 }} />
            )}
          </div>
          <button
            onClick={doRedeploy}
            disabled={redeployBusy}
            className="btn"
            style={{ width: '100%', fontSize: 9 }}
          >
            {redeployBusy ? 'Redeploying...' : 'Redeploy Now'}
          </button>
        </div>
      )}

      {/* Deployment history panel */}
      {showHistory && (
        <div style={{ marginBottom: 6 }}>
          {deployments.length === 0 ? (
            <div className="mono" style={{ fontSize: 9, color: 'var(--fg-faint)', padding: 4 }}>
              No deployment history
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {deployments.map((dep, i) => (
                <div key={dep.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                  background: 'var(--bg-alt)', border: '1px solid var(--fg)',
                  fontSize: 9,
                }}>
                  <span className="mono" style={{ color: 'var(--fg-faint)', width: 50, flexShrink: 0 }}>
                    {dep.git_commit.slice(0, 7)}
                  </span>
                  <span className="mono" style={{ flex: 1, color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {new Date(dep.created_at).toLocaleString()}
                  </span>
                  {i > 0 && (
                    <button onClick={() => handleRollback(dep.id)} className="act" style={{ fontSize: 8 }} disabled={anyBusy}>
                      Rollback
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom row: server + remove */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
          on {serverName}
        </span>
        <button
          onClick={remove.click}
          disabled={anyBusy}
          className="act"
          style={{ color: remove.armed ? 'var(--red)' : undefined }}
        >
          {remove.armed ? 'Confirm?' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

