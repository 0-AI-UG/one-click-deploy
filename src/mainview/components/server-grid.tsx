import { useState, useRef, useCallback } from "react";
import { request } from "../rpc.ts";
import type { ServerWithApps, App, DeploymentRecord } from "../../shared/rpc.ts";

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

  if (allApps.length === 0 && servers.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '28px 16px',
        border: '2px dashed var(--fg)', background: 'var(--bg-alt)',
      }}>
        <div className="mono" style={{ fontSize: 28, fontWeight: 900, marginBottom: 4, letterSpacing: '-0.04em' }}>
          :/
        </div>
        <div className="mono" style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>
          Nothing running
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
          it's quiet here. too quiet.
        </div>
      </div>
    );
  }

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

      {servers.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: 'var(--fg-faint)', letterSpacing: '.08em', textTransform: 'uppercase' }}>Servers</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {servers.map(server => (
              <ServerRow key={server.id} server={server} onChanged={onChanged} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function useConfirmAction(action: () => Promise<void>, timeout = 2000) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const click = useCallback(async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), timeout);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    await action();
    setBusy(false);
  }, [armed, busy, action, timeout]);

  return { armed, busy, click };
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

  const anyBusy = remove.busy || restart.busy || pause.busy || redeployBusy || actionBusy || webhookBusy;

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
              <input type="checkbox" checked={redeployAuthEnabled} onChange={e => setRedeployAuthEnabled(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
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

function ServerRow({ server, onChanged }: { server: ServerWithApps; onChanged: () => void }) {
  const { armed, busy, click } = useConfirmAction(async () => {
    await request.deleteServer({ server_id: server.id });
    onChanged();
  });

  const statusDot =
    server.status === "ready" ? "dot-ok" :
    server.status === "provisioning" ? "dot-warn" : "dot-err";

  const statusLabel =
    server.status === "ready" ? "Ready" :
    server.status === "provisioning" ? "Starting..." : "Offline";

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px', border: '1.5px solid var(--fg)',
      background: 'var(--bg-raised)', opacity: busy ? 0.4 : 1,
    }}>
      <div className={`dot ${statusDot}`} />
      <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{server.name}</span>
      <span className="mono" style={{ fontSize: 9, color: 'var(--fg-faint)' }}>
        {server.apps.length} app{server.apps.length !== 1 ? 's' : ''}
      </span>
      <span className="mono" style={{ fontSize: 9, color: 'var(--fg-faint)' }}>{statusLabel}</span>
      <button
        onClick={click}
        disabled={busy}
        className="act"
        style={{ color: armed || busy ? 'var(--red)' : undefined }}
      >
        {armed ? 'Confirm?' : 'Delete'}
      </button>
    </div>
  );
}
