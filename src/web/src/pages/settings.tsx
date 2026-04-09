import { useState, useEffect } from "react";
import { get, post, put } from "../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Settings as SettingsIcon, Save, RefreshCw, Server as ServerIcon, Shield, Fingerprint, KeyRound, Trash2 } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

type PasskeyInfo = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string };

function SecuritySection() {
  const [status, setStatus] = useState<any>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const refresh = () => {
    Promise.all([
      get("/api/auth/totp/status"),
      get("/api/auth/webauthn/credentials"),
    ]).then(([s, p]) => {
      setStatus(s);
      setPasskeys(p);
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const addPasskey = async () => {
    setBusy(true);
    try {
      const options = await post("/api/auth/webauthn/register-options");
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify", { credential });
      if (res.backupCodes) {
        showToast(`Passkey added. Save your backup codes: ${res.backupCodes.join(", ")}`, "success");
      } else {
        showToast("Passkey added", "success");
      }
      refresh();
    } catch (err: any) {
      if (err.name !== "NotAllowedError") {
        showToast(err.message || "Failed to add passkey", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const deletePasskey = async (id: string, name: string) => {
    if (!confirm(`Remove passkey "${name}"?`)) return;
    setBusy(true);
    try {
      await post("/api/auth/webauthn/delete", { credentialId: id });
      showToast("Passkey removed", "success");
      refresh();
    } catch (err: any) {
      showToast(err.message || "Failed to remove passkey", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="p-5 mt-6"><div className="flex justify-center"><Spinner /></div></Card>;
  if (!status) return null;

  return (
    <Card className="p-5 space-y-4 mt-6">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Security</h3>
      </div>

      {/* TOTP Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-muted" />
          <span className="font-mono text-[11px] text-fg font-bold">Authenticator App</span>
        </div>
        <span className={`font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg ${status.enabled ? "bg-green-200" : "bg-alt"}`}>
          {status.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {/* Passkeys */}
      <div className="border-t-2 border-fg pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Fingerprint size={14} className="text-muted" />
            <span className="font-mono text-[11px] text-fg font-bold">Passkeys</span>
          </div>
          {supportsWebAuthn && (
            <Btn size="xs" loading={busy} onClick={addPasskey}>
              + Add Passkey
            </Btn>
          )}
        </div>
        {passkeys.length === 0 ? (
          <p className="font-mono text-[10px] text-muted">No passkeys registered.</p>
        ) : (
          <div className="space-y-1">
            {passkeys.map((pk) => (
              <div key={pk.id} className="flex items-center justify-between bg-alt border-2 border-fg px-3 py-2">
                <div>
                  <span className="font-mono text-[10px] text-fg font-bold">{pk.name}</span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {pk.backedUp ? "Synced" : pk.deviceType === "singleDevice" ? "Device-bound" : ""}
                  </span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {new Date(pk.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  onClick={() => deletePasskey(pk.id, pk.name)}
                  disabled={busy}
                  className="text-muted hover:text-red-500 transition-colors disabled:opacity-35"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!supportsWebAuthn && (
          <p className="font-mono text-[9px] text-muted mt-1">Your browser does not support passkeys.</p>
        )}
      </div>

      {/* Backup codes */}
      {(status.enabled || status.webauthnEnabled) && (
        <div className="border-t-2 border-fg pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-fg font-bold">Backup Codes</span>
            <span className="font-mono text-[10px] text-muted">{status.backupCodesRemaining} remaining</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const [form, setForm] = useState({
    hetzner_api_token: "", github_pat: "",
    dns_zone_id: "", default_server_type: "", default_location: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { serverTypes } = useServerTypes();

  const [panel, setPanel] = useState<any>(null);
  const [panelServer, setPanelServer] = useState<any>(null);
  const [panelDeployments, setPanelDeployments] = useState<any[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);

  const refreshPanel = () => {
    get("/api/panel")
      .then((data) => {
        setPanel(data.panel);
        setPanelServer(data.server);
      })
      .catch(() => {});
    get("/api/panel/deployments")
      .then((data) => setPanelDeployments(data || []))
      .catch(() => {});
  };

  useEffect(() => {
    get("/api/settings").then((data) => {
      setForm(data);
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
    refreshPanel();
  }, []);

  // Auto-select first available type/location if none saved
  useEffect(() => {
    if (serverTypes.length > 0 && !form.default_server_type) {
      const first = serverTypes[0];
      setForm((f) => ({ ...f, default_server_type: first.name, default_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes, form.default_server_type]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const redeployPanelNow = async () => {
    if (!confirm(
      "Redeploy the panel?\n\nThe panel will become unavailable for ~30–60s while it rebuilds from the latest commit on main. You will need to reload this page once it comes back.",
    )) return;
    setPanelBusy(true);
    try {
      const result = await post("/api/panel/redeploy");
      if (result?.ok) {
        showToast("Panel rebuild dispatched. It will be unavailable briefly.", "success");
        setTimeout(refreshPanel, 2000);
      } else {
        showToast(result?.error || "Failed to dispatch redeploy", "error");
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setPanelBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await put("/api/settings", form);
      showToast("Settings saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-6">
        <SettingsIcon size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Settings</h1>
      </div>

      <Card className="p-5 space-y-4">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">API Tokens</h3>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner API Token</label>
          <input type="password" value={form.hetzner_api_token} onChange={set("hetzner_api_token")} placeholder="Enter token" />
        </div>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">GitHub Personal Access Token</label>
          <input type="password" value={form.github_pat} onChange={set("github_pat")} placeholder="Optional" />
        </div>

        <div className="border-t-2 border-fg pt-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Defaults</h3>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID</label>
            <input type="text" value={form.dns_zone_id} onChange={set("dns_zone_id")} placeholder="Hetzner DNS Zone ID" />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
              <NeoSelect
                value={form.default_server_type}
                onChange={(v) => {
                  setForm((f) => {
                    const locs = locationOptions(serverTypes, v);
                    const locValid = locs.some((l) => l.value === f.default_location);
                    return { ...f, default_server_type: v, ...(!locValid && locs.length ? { default_location: locs[0].value } : {}) };
                  });
                }}
                options={typeOptions(serverTypes)}
              />
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Location</label>
              <NeoSelect
                value={form.default_location}
                onChange={(v) => setForm((f) => ({ ...f, default_location: v }))}
                options={locationOptions(serverTypes, form.default_server_type)}
              />
            </div>
          </div>
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={save}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

      <SecuritySection />

      {panel && (
        <Card className="p-5 space-y-4 mt-6">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-2">
              <ServerIcon size={12} /> Panel (self-hosted)
            </h3>
            <span
              className={`font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg ${
                panel.status === "running"
                  ? "bg-green-200"
                  : panel.status === "error"
                  ? "bg-red-200"
                  : "bg-yellow-200"
              }`}
            >
              {panel.status}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
            <div className="text-muted">Domain</div>
            <div className="text-fg break-all">
              <a href={`https://${panel.domain}`} target="_blank" rel="noreferrer" className="underline">
                {panel.domain}
              </a>
            </div>
            <div className="text-muted">Container</div>
            <div className="text-fg">{panel.name}</div>
            <div className="text-muted">Server</div>
            <div className="text-fg">{panelServer ? `${panelServer.name} (${panelServer.ipv4})` : "—"}</div>
            <div className="text-muted">Branch</div>
            <div className="text-fg">{panel.git_branch}</div>
            <div className="text-muted">Volume</div>
            <div className="text-fg break-all">{panel.volume_mount || "—"}</div>
          </div>

          <div className="pt-1">
            <Btn variant="primary" loading={panelBusy} onClick={redeployPanelNow}>
              <RefreshCw size={13} /> Redeploy panel
            </Btn>
            <p className="mt-2 text-[10px] text-muted font-mono">
              Pulls the latest commit on <span className="text-fg">{panel.git_branch}</span>, rebuilds the image, and replaces this container. The page will be unavailable for ~30–60s.
            </p>
          </div>

          <div className="border-t-2 border-fg pt-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[11px] text-fg font-bold">
                  Auto-update from {panel.git_branch}
                </div>
                <div className="font-mono text-[10px] text-muted mt-0.5">
                  Register a GitHub webhook on {panel.git_repo} so each push to{" "}
                  <span className="text-fg">{panel.git_branch}</span> triggers a redeploy.
                </div>
              </div>
              <Btn
                variant={panel.webhook_enabled ? "default" : "primary"}
                loading={panelBusy}
                onClick={async () => {
                  setPanelBusy(true);
                  try {
                    const path = panel.webhook_enabled
                      ? "/api/panel/webhook/disable"
                      : "/api/panel/webhook/enable";
                    const r = await post(path);
                    if (r?.ok) {
                      showToast(panel.webhook_enabled ? "Webhook disabled" : "Webhook enabled", "success");
                      refreshPanel();
                    } else {
                      showToast(r?.error || "Failed", "error");
                    }
                  } catch (err: any) {
                    showToast(err.message, "error");
                  } finally {
                    setPanelBusy(false);
                  }
                }}
              >
                {panel.webhook_enabled ? "Disable" : "Enable"}
              </Btn>
            </div>
          </div>

          {panelDeployments.length > 0 && (
            <div className="border-t-2 border-fg pt-3">
              <h4 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Recent deployments</h4>
              <div className="space-y-1 text-[11px] font-mono max-h-48 overflow-y-auto">
                {panelDeployments.slice(0, 10).map((d) => (
                  <div key={d.id} className="flex justify-between gap-2">
                    <span className="text-muted truncate">
                      {new Date(d.created_at).toLocaleString()}
                    </span>
                    <span className="text-fg">{d.source}</span>
                    <span className="text-muted truncate" title={d.git_commit}>
                      {d.git_commit?.slice(0, 12) || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
