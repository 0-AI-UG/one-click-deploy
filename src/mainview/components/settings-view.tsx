import { useState, useEffect, useRef } from "react";
import { request } from "../rpc.ts";
import type { Settings } from "../../shared/rpc.ts";
import { NeoSelect } from "./neo-select.tsx";

type HetznerServerType = { name: string; description: string; cores: number; memory: number; disk: number; locations: string[] };

export function SettingsView({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [token, setToken] = useState(settings.hetzner_api_token);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [importArmed, setImportArmed] = useState(false);
  const importArmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const exportSshKey = async () => {
    setKeyBusy(true);
    setKeyStatus(null);
    try {
      const data = await request.exportSshKey({});
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ocd-ssh-key-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setKeyStatus({ kind: "ok", msg: "Exported." });
    } catch (err: any) {
      setKeyStatus({ kind: "err", msg: err.message || "Export failed" });
    } finally {
      setKeyBusy(false);
    }
  };

  const onImportClick = () => {
    if (keyBusy) return;
    if (!importArmed) {
      setImportArmed(true);
      setKeyStatus(null);
      importArmTimer.current = setTimeout(() => setImportArmed(false), 3000);
      return;
    }
    clearTimeout(importArmTimer.current);
    setImportArmed(false);
    fileInputRef.current?.click();
  };

  const importSshKey = async (file: File) => {
    setKeyBusy(true);
    setKeyStatus(null);
    try {
      const parsed = JSON.parse(await file.text());
      await request.importSshKey(parsed);
      setKeyStatus({ kind: "ok", msg: "SSH key imported." });
    } catch (err: any) {
      setKeyStatus({ kind: "err", msg: err.message || "Import failed" });
    } finally {
      setKeyBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    await request.saveSettings({ ...settings, hetzner_api_token: token, github_pat: githubPat, dns_zone_id: zoneId, default_server_type: serverType, default_location: location });
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

      <div>
        <div className="stamp" style={{ marginBottom: 8 }}>SSH Key</div>
        <div className="card" style={{ padding: 12 }}>
          <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginBottom: 6, lineHeight: 1.4 }}>
            Share with another OCD instance to manage the same fleet.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={exportSshKey} disabled={keyBusy} className="btn" style={{ flex: 1 }}>Export</button>
            <button onClick={onImportClick} disabled={keyBusy} className="btn" style={{ flex: 1 }}>
              {importArmed ? "Confirm?" : "Import"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importSshKey(f);
                e.target.value = "";
              }}
            />
          </div>
          {importArmed && (
            <div className="mono" style={{ fontSize: 7, color: 'var(--fg-faint)', marginTop: 6, lineHeight: 1.4 }}>
              Overwrites current key. Old-key servers become unreachable without a backup.
            </div>
          )}
          {keyStatus && (
            <div className="mono" style={{ fontSize: 7, color: keyStatus.kind === "err" ? "#c00" : "var(--fg-faint)", marginTop: 6, lineHeight: 1.4 }}>
              {keyStatus.msg}
            </div>
          )}
          <div className="mono" style={{ fontSize: 7, color: '#c00', marginTop: 6, lineHeight: 1.3 }}>
            Export contains a private key that can root every provisioned server.
          </div>
        </div>
      </div>
    </div>
  );
}

