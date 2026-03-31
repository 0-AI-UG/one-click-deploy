import { useState, useRef, useCallback } from "react";
import { request } from "../rpc.ts";
import type { ServerWithApps, App } from "../../shared/rpc.ts";

export function ServerGrid({
  servers,
  onChanged,
}: {
  servers: ServerWithApps[];
  onChanged: () => void;
}) {
  const allApps = servers.flatMap(s => s.apps.map(a => ({ ...a, server: s })));

  if (allApps.length === 0 && servers.length === 0) return null;

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
            <AppCard key={app.id} app={app} serverName={app.server.name} onChanged={onChanged} />
          ))}
        </div>
      )}

      {/* Servers summary */}
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

function AppCard({ app, serverName, onChanged }: { app: App; serverName: string; onChanged: () => void }) {
  const { armed, busy, click } = useConfirmAction(async () => {
    await request.destroyApp({ app_id: app.id });
    onChanged();
  });

  const statusLabel =
    app.status === "running" ? "Online" :
    app.status === "deploying" ? "Starting..." :
    app.status === "error" ? "Error" : "Stopped";

  const statusDot =
    app.status === "running" ? "dot-ok" :
    app.status === "deploying" ? "dot-warn" :
    app.status === "error" ? "dot-err" : "dot-off";

  return (
    <div className="card" style={{ padding: 10, opacity: busy ? 0.4 : 1 }}>
      {/* Top row: name + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div className={`dot ${statusDot}`} />
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{app.name}</span>
        <span className="mono" style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.04em',
          color: app.status === "running" ? 'var(--fg)' : app.status === "error" ? 'var(--red)' : 'var(--fg-faint)',
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

      {/* Bottom row: server + remove */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
          on {serverName}
        </span>
        <button
          onClick={click}
          disabled={busy}
          className="act"
          style={{ color: armed || busy ? 'var(--red)' : undefined }}
        >
          Remove
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
        Delete
      </button>
    </div>
  );
}
