import { useState, useEffect } from "react";
import { request } from "../rpc.ts";
import type { Settings } from "../../shared/rpc.ts";
import { NeoSelect } from "./neo-select.tsx";

type HetznerServerType = { name: string; description: string; cores: number; memory: number; disk: number; locations: string[] };

export function SettingsView({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [token, setToken] = useState(settings.hetzner_api_token);
  const [dnsToken, setDnsToken] = useState(settings.hetzner_dns_token);
  const [githubPat, setGithubPat] = useState(settings.github_pat);
  const [zoneId, setZoneId] = useState(settings.dns_zone_id);
  const [serverType, setServerType] = useState(settings.default_server_type || "");
  const [location, setLocation] = useState(settings.default_location || "");
  const [saving, setSaving] = useState(false);
  const [serverTypes, setServerTypes] = useState<HetznerServerType[]>([]);

  useEffect(() => {
    request.getServerTypes({}).then((data: any) => {
      const types = data.server_types ?? [];
      setServerTypes(types);
      if (!serverType && types.length > 0) setServerType(types[0].name);
      if (!location && types.length > 0 && types[0].locations.length > 0) setLocation(types[0].locations[0]);
    }).catch(() => {});
  }, []);

  const selectedType = serverTypes.find(t => t.name === serverType);
  const availableLocations = selectedType?.locations ?? [];

  // If current location isn't valid for the selected type, auto-fix
  useEffect(() => {
    if (availableLocations.length > 0 && !availableLocations.includes(location)) {
      setLocation(availableLocations[0]);
    }
  }, [serverType, availableLocations]);

  const save = async () => {
    setSaving(true);
    await request.saveSettings({ ...settings, hetzner_api_token: token, hetzner_dns_token: dnsToken, github_pat: githubPat, dns_zone_id: zoneId, default_server_type: serverType, default_location: location });
    setSaving(false);
    onSaved();
  };

  return (
    <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
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
            {serverTypes.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <label className="lbl">Server Type</label>
                  <NeoSelect
                    value={serverType}
                    onChange={setServerType}
                    options={serverTypes.map(t => ({ value: t.name, label: `${t.name} (${t.cores}c/${t.memory}GB)` }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="lbl">Location</label>
                  <NeoSelect
                    value={location}
                    onChange={setLocation}
                    options={availableLocations.map(l => ({ value: l, label: l }))}
                  />
                </div>
              </div>
            )}
            <button onClick={save} disabled={saving || !token} className="btn" style={{ width: '100%' }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}

