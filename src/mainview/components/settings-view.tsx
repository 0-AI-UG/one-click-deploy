import { useState } from "react";
import { request } from "../rpc.ts";
import type { Settings } from "../../shared/rpc.ts";

export function SettingsView({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [token, setToken] = useState(settings.hetzner_api_token);
  const [dnsToken, setDnsToken] = useState(settings.hetzner_dns_token);
  const [githubPat, setGithubPat] = useState(settings.github_pat);
  const [zoneId, setZoneId] = useState(settings.dns_zone_id);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await request.saveSettings({ ...settings, hetzner_api_token: token, hetzner_dns_token: dnsToken, github_pat: githubPat, dns_zone_id: zoneId });
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
            <label className="lbl">GitHub Token</label>
            <input type="password" value={githubPat} onChange={e => setGithubPat(e.target.value)} placeholder="Optional — for private repos & webhooks" className="inp" />
            <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginTop: 2, display: 'block' }}>
              Scopes: repo + admin:repo_hook
            </span>
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
