import { useState, useEffect } from "react";
import { request } from "./rpc.ts";
import type { ServerWithApps, Settings } from "../shared/rpc.ts";
import { DeploySection } from "./components/deploy-section.tsx";
import { ServerGrid } from "./components/server-grid.tsx";
import { SetupGate } from "./components/setup-gate.tsx";
import { Logo } from "./components/logo.tsx";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [servers, setServers] = useState<ServerWithApps[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"main" | "settings">("main");

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

  if (loading) {
    return (
      <Shell>
        <Bar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spin" style={{ width: 18, height: 18, border: '2px solid var(--fg)', borderTopColor: 'var(--accent)' }} />
        </div>
      </Shell>
    );
  }

  if (needsSetup) {
    return (
      <Shell>
        <Bar />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <SetupGate onSaved={load} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Bar showGear active={view === "settings"} onGear={() => setView(view === "settings" ? "main" : "settings")} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'auto', padding: 16 }}>
        <div style={{ flex: 1 }} />
        {view === "settings" && settings ? (
          <SettingsView settings={settings} onSaved={() => { setView("main"); load(); }} />
        ) : (
          <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DeploySection servers={servers} onDeployed={load} />
            <ServerGrid servers={servers} onChanged={load} />
          </div>
        )}
        <div style={{ flex: 1 }} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>{children}</div>;
}

function Bar({ showGear, active, onGear }: { showGear?: boolean; active?: boolean; onGear?: () => void }) {
  return (
    <div
      className="drag-region"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 32, padding: '0 12px', background: 'var(--accent)', borderBottom: 'var(--b)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Logo size={18} />
        <span className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Deploy</span>
      </div>
      {showGear && (
        <button
          className="no-drag"
          onClick={onGear}
          style={{
            width: 20, height: 20, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: active ? 'var(--fg)' : 'transparent',
            color: active ? 'var(--accent)' : 'var(--fg)',
            border: '1.5px solid var(--fg)', cursor: 'pointer',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SettingsView({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [token, setToken] = useState(settings.hetzner_api_token);
  const [dnsToken, setDnsToken] = useState(settings.hetzner_dns_token);
  const [zoneId, setZoneId] = useState(settings.dns_zone_id);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await request.saveSettings({ ...settings, hetzner_api_token: token, hetzner_dns_token: dnsToken, dns_zone_id: zoneId });
    setSaving(false);
    onSaved();
  };

  return (
    <div style={{ width: '100%', maxWidth: 360 }}>
      <div className="stamp" style={{ marginBottom: 8 }}>Settings</div>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label className="lbl">API Token</label>
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Hetzner API token" className="inp" />
          </div>
          <div>
            <label className="lbl">DNS Token</label>
            <input type="password" value={dnsToken} onChange={e => setDnsToken(e.target.value)} placeholder="DNS API token" className="inp" />
          </div>
          <div>
            <label className="lbl">Zone ID</label>
            <input value={zoneId} onChange={e => setZoneId(e.target.value)} placeholder="Optional" className="inp" />
          </div>
          <button onClick={save} disabled={saving || !token} className="btn" style={{ width: '100%' }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
