import { useState, useEffect } from "react";
import { request } from "./rpc.ts";
import type { ServerWithApps, Settings, App } from "../shared/rpc.ts";
import { DeploySection } from "./components/deploy-section.tsx";
import { ServerGrid } from "./components/server-grid.tsx";
import { ResourcesView } from "./components/resources-view.tsx";
import { SetupGate } from "./components/setup-gate.tsx";
import { Logo } from "./components/logo.tsx";
import { LogsView } from "./components/logs-view.tsx";
import { SettingsView } from "./components/settings-view.tsx";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [servers, setServers] = useState<ServerWithApps[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"deploy" | "apps" | "resources" | "settings" | "logs">("apps");
  const [logsApp, setLogsApp] = useState<App | null>(null);

  const load = async () => {
    try {
      const [s, srv] = await Promise.all([
        request.getSettings({}),
        request.getServers({}),
      ]);
      setSettings(s as any);
      setServers(srv as any);
    } catch (err) {
      console.error("Load failed:", err);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const needsSetup = settings && !settings.hetzner_api_token;

  const openLogs = (app: App) => {
    setLogsApp(app);
    setView("logs");
  };

  const closeLogs = () => {
    setLogsApp(null);
    setView("apps");
  };

  if (loading) {
    return (
      <Shell>
        <Bar view="" onNav={() => {}} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spin" style={{ width: 18, height: 18, border: '2px solid var(--fg)', borderTopColor: 'var(--accent)' }} />
        </div>
      </Shell>
    );
  }

  if (needsSetup) {
    return (
      <Shell>
        <Bar view="" onNav={() => {}} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <SetupGate onSaved={load} />
        </div>
      </Shell>
    );
  }

  const isSubView = view === "logs";

  return (
    <Shell>
      <Bar
        view={view}
        onNav={(v) => setView(v)}
        showBack={isSubView}
        onBack={closeLogs}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', padding: view === "logs" ? 0 : 16 }}>
        {view === "logs" && logsApp ? (
          <LogsView app={logsApp} />
        ) : view === "settings" && settings ? (
          <div style={{ margin: 'auto 0', width: '100%', display: 'flex', justifyContent: 'center' }}>
            <SettingsView settings={settings} onSaved={() => { load(); }} />
          </div>
        ) : view === "deploy" ? (
          <div style={{ margin: 'auto 0', width: '100%', maxWidth: 360 }}>
            <DeploySection servers={servers} onDeployed={() => { load(); setView("apps"); }} />
          </div>
        ) : view === "resources" ? (
          <div style={{ margin: 'auto 0', width: '100%', maxWidth: 400 }}>
            <ResourcesView onChanged={load} />
          </div>
        ) : (
          <div style={{ margin: 'auto 0', width: '100%', maxWidth: 360 }}>
            <ServerGrid servers={servers} onChanged={load} onViewLogs={openLogs} />
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>{children}</div>;
}

function NavBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className="no-drag mono"
      onClick={onClick}
      style={{
        fontSize: 8, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
        padding: '0 10px', height: '100%',
        background: active ? 'var(--fg)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg)',
        border: 'none', borderLeft: '1.5px solid var(--fg)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function Bar({ view, onNav, showBack, onBack }: {
  view: string;
  onNav: (v: "deploy" | "apps" | "resources" | "settings") => void;
  showBack?: boolean;
  onBack?: () => void;
}) {
  return (
    <div
      className="drag-region"
      style={{
        display: 'flex', alignItems: 'center',
        height: 32, background: 'var(--accent)', borderBottom: 'var(--b)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px' }}>
        {showBack && (
          <button
            className="no-drag"
            onClick={onBack}
            style={{
              width: 20, height: 20, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', color: 'var(--fg)',
              border: '1.5px solid var(--fg)', cursor: 'pointer', marginRight: 4,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <Logo size={18} />
      </div>
      <div style={{ flex: 1 }} />
      {!showBack && (
        <div style={{ display: 'flex', height: '100%' }}>
          <NavBtn label="Apps" active={view === "apps"} onClick={() => onNav("apps")} />
          <NavBtn label="Deploy" active={view === "deploy"} onClick={() => onNav("deploy")} />
          <NavBtn label="Resources" active={view === "resources"} onClick={() => onNav("resources")} />
          <NavBtn label="Settings" active={view === "settings"} onClick={() => onNav("settings")} />
        </div>
      )}
    </div>
  );
}
