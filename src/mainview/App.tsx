import { useState, useEffect } from "react";
import { request } from "./rpc.ts";
import type { ServerWithApps, Settings, App } from "../shared/rpc.ts";
import { DeploySection } from "./components/deploy-section.tsx";
import { ServerGrid } from "./components/server-grid.tsx";
import { SetupGate } from "./components/setup-gate.tsx";
import { Logo } from "./components/logo.tsx";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [servers, setServers] = useState<ServerWithApps[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"deploy" | "apps" | "settings" | "logs">("apps");
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden', padding: view === "logs" ? 0 : 16 }}>
        {view === "logs" && logsApp ? (
          <LogsView app={logsApp} />
        ) : view === "settings" && settings ? (
          <>
            <div style={{ flex: 1 }} />
            <SettingsView settings={settings} onSaved={() => { load(); }} />
            <div style={{ flex: 1 }} />
          </>
        ) : view === "deploy" ? (
          <>
            <div style={{ flex: 1 }} />
            <div style={{ width: '100%', maxWidth: 360 }}>
              <DeploySection servers={servers} onDeployed={() => { load(); setView("apps"); }} />
            </div>
            <div style={{ flex: 1 }} />
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <div style={{ width: '100%', maxWidth: 360 }}>
              <ServerGrid servers={servers} onChanged={load} onViewLogs={openLogs} />
            </div>
            <div style={{ flex: 1 }} />
          </>
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
  onNav: (v: "deploy" | "apps" | "settings") => void;
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
          <NavBtn label="Settings" active={view === "settings"} onClick={() => onNav("settings")} />
        </div>
      )}
    </div>
  );
}

// --- ANSI parsing ---
const ANSI_COLORS: Record<number, string> = {
  30: '#1A1A1A', 31: '#CC0000', 32: '#1A8A00', 33: '#B58600',
  34: '#3366CC', 35: '#8B45A6', 36: '#0E7A7A', 37: '#4A4A4A',
  90: '#8A8A8A', 91: '#FF4444', 92: '#2EAA10', 93: '#CC9900',
  94: '#5B8DEF', 95: '#B070E0', 96: '#18A0A0', 97: '#1A1A1A',
};
type LogSpan = { text: string; color?: string; bold?: boolean; dim?: boolean };
function parseAnsi(line: string): LogSpan[] {
  const spans: LogSpan[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, color: string | undefined, bold = false, dim = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index), color, bold, dim });
    for (const c of m[1].split(';').map(Number)) {
      if (c === 0) { color = undefined; bold = false; dim = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
    }
    last = re.lastIndex;
  }
  if (last < line.length) spans.push({ text: line.slice(last), color, bold, dim });
  return spans.length > 0 ? spans : [{ text: line }];
}

function getLevel(line: string): 'error' | 'warn' | 'info' | 'debug' | null {
  const l = line.toLowerCase();
  if (/\b(error|err|fatal|panic|exception)\b/.test(l)) return 'error';
  if (/\b(warn|warning)\b/.test(l)) return 'warn';
  if (/\b(info)\b/.test(l)) return 'info';
  if (/\b(debug|trace)\b/.test(l)) return 'debug';
  return null;
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*\|?\s*|\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\]\s*|\d{2}:\d{2}:\d{2}[.\d]*\s*\|?\s*)/;

function LogLine({ line, num }: { line: string; num: number }) {
  const level = getLevel(line);
  const spans = parseAnsi(line);
  const hasAnsi = spans.some(s => s.color);
  const plain = spans.map(s => s.text).join('');
  const ts = plain.match(TS_RE);

  const stripe =
    level === 'error' ? 'var(--red)' :
    level === 'warn' ? 'var(--amber)' :
    level === 'info' ? 'var(--accent)' :
    level === 'debug' ? 'var(--fg-faint)' : 'var(--bg-alt)';

  return (
    <div style={{
      display: 'flex', alignItems: 'baseline',
      borderLeft: `3px solid ${stripe}`,
      background: level === 'error' ? '#FF444412' : undefined,
      padding: '1px 0',
      minHeight: 14,
    }}>
      <span style={{
        width: 26, flexShrink: 0, textAlign: 'right', paddingRight: 6,
        color: 'var(--fg-faint)', fontSize: 8, lineHeight: '14px', userSelect: 'none',
      }}>
        {num}
      </span>
      <span style={{ flex: 1, paddingRight: 8, lineHeight: '14px', wordBreak: 'break-all' }}>
        {hasAnsi ? spans.map((s, i) => (
          <span key={i} style={{
            color: s.color, fontWeight: s.bold ? 700 : undefined, opacity: s.dim ? 0.5 : undefined,
          }}>{s.text}</span>
        )) : (
          <>
            {ts && <span style={{ color: 'var(--fg-faint)' }}>{ts[0]}</span>}
            <span style={{
              color: level === 'error' ? 'var(--red)' : level === 'warn' ? 'var(--amber)' : 'var(--fg)',
              fontWeight: level === 'error' ? 700 : undefined,
            }}>{ts ? plain.slice(ts[0].length) : plain}</span>
          </>
        )}
      </span>
    </div>
  );
}

function LogsView({ app }: { app: App }) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [lineCount, setLineCount] = useState(0);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const result = await request.getContainerLogs({ app_id: app.id, tail: 200 });
      const text = result.error ? `Error: ${result.error}` : result.logs;
      setLogs(text);
      setLineCount(text ? text.split('\n').length : 0);
    } catch (err: any) {
      setLogs(`Error: ${err.message}`);
    }
    setLoading(false);
  };

  useEffect(() => { fetchLogs(); }, [app.id]);

  const lines = logs ? logs.split('\n') : [];
  const errCount = lines.filter(l => getLevel(l) === 'error').length;
  const warnCount = lines.filter(l => getLevel(l) === 'warn').length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      background: 'var(--bg)',
    }}>
      {/* Header — cream strip with brutalist elements */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        height: 36, flexShrink: 0,
        background: '#FFFDF5', borderBottom: '2px solid #1A1A1A',
      }}>
        {/* App name block */}
        <div style={{
          height: '100%', padding: '0 14px',
          display: 'flex', alignItems: 'center',
          background: '#BAFF39', borderRight: '2px solid #1A1A1A',
        }}>
          <span className="mono" style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase',
            color: '#1A1A1A',
          }}>
            {app.name}
          </span>
        </div>

        {/* Stats badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, height: '100%' }}>
          <div style={{
            height: '100%', padding: '0 10px', display: 'flex', alignItems: 'center',
            borderRight: '2px solid #1A1A1A',
          }}>
            <span className="mono" style={{ fontSize: 8, color: '#8A8A8A', fontWeight: 700 }}>
              {lineCount}
            </span>
            <span className="mono" style={{ fontSize: 7, color: '#8A8A8A', marginLeft: 3, letterSpacing: '.04em' }}>
              LN
            </span>
          </div>
          {errCount > 0 && (
            <div style={{
              height: '100%', padding: '0 10px', display: 'flex', alignItems: 'center',
              borderRight: '2px solid #1A1A1A', background: '#FF444412',
            }}>
              <span className="mono" style={{ fontSize: 8, color: '#FF4444', fontWeight: 700 }}>
                {errCount}
              </span>
              <span className="mono" style={{ fontSize: 7, color: '#FF4444', marginLeft: 3, letterSpacing: '.04em' }}>
                ERR
              </span>
            </div>
          )}
          {warnCount > 0 && (
            <div style={{
              height: '100%', padding: '0 10px', display: 'flex', alignItems: 'center',
              borderRight: '2px solid #1A1A1A',
            }}>
              <span className="mono" style={{ fontSize: 8, color: '#FFB800', fontWeight: 700 }}>
                {warnCount}
              </span>
              <span className="mono" style={{ fontSize: 7, color: '#FFB800', marginLeft: 3, letterSpacing: '.04em' }}>
                WRN
              </span>
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Refresh button */}
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="no-drag"
          style={{
            height: '100%', padding: '0 14px',
            background: loading ? '#F0EBE1' : '#1A1A1A',
            color: loading ? '#8A8A8A' : '#FFFDF5',
            border: 'none', borderLeft: '2px solid #1A1A1A',
            fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700,
            letterSpacing: '.1em', textTransform: 'uppercase',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'LOADING' : 'REFRESH'}
        </button>
      </div>

      {/* Log body */}
      <div className="mono" style={{
        flex: 1, overflow: 'auto', fontSize: 9,
        padding: '2px 0',
      }}>
        {lines.length === 0 && !loading && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                display: 'inline-block', padding: '6px 16px',
                background: '#BAFF39', border: '2px solid #BAFF39',
                color: '#1A1A1A', fontSize: 10, fontWeight: 700,
                letterSpacing: '.1em', marginBottom: 8,
              }}>
                NO OUTPUT
              </div>
              <div style={{ fontSize: 9, color: 'var(--fg-faint)' }}>
                Container has not produced logs yet
              </div>
            </div>
          </div>
        )}
        {lines.map((line, i) => (
          <LogLine key={i} line={line} num={i + 1} />
        ))}
      </div>
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
