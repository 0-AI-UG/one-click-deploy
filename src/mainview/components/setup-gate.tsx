import { useState } from "react";
import { request } from "../rpc.ts";
import { Logo } from "./logo.tsx";

export function SetupGate({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await request.saveSettings({
        hetzner_api_token: token,
        dns_zone_id: "",
        default_server_type: "",
        default_location: "",
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "Failed to save");
    }
    setSaving(false);
  };

  return (
    <div style={{ width: '100%', maxWidth: 320, padding: '0 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Logo size={36} />
        <div>
          <div className="mono" style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>Setup</div>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 1 }}>Connect Hetzner to deploy</div>
        </div>
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label className="lbl">API Token</label>
            <input
              type="password" value={token} onChange={e => setToken(e.target.value)}
              placeholder="Paste your token" className="inp" autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && token) save(); }}
            />
            <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginTop: 4 }}>
              Hetzner Cloud Console → API tokens
            </div>
          </div>

          {error && (
            <div className="mono" style={{ fontSize: 9, fontWeight: 700, color: 'var(--red)', padding: '5px 8px', background: 'var(--red-dim)', border: '1.5px solid var(--red)' }}>
              {error}
            </div>
          )}

          <button onClick={save} disabled={saving || !token} className="btn" style={{ width: '100%' }}>
            {saving ? 'Connecting...' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
