import { useState, useEffect } from "react";
import { get, post, put } from "../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Settings as SettingsIcon, Save, RefreshCw, Server as ServerIcon } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";

export function SettingsPage() {
  const [form, setForm] = useState({
    hetzner_api_token: "", github_pat: "",
    dns_zone_id: "", default_server_type: "", default_location: "",
    require_2fa: true,
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

        <div className="border-t-2 border-fg pt-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Security</h3>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.require_2fa}
              onChange={(e) => setForm((f) => ({ ...f, require_2fa: e.target.checked }))}
              className="mt-0.5"
            />
            <span>
              <span className="font-mono text-[11px] text-fg font-bold block">Require 2FA for all users</span>
              <span className="font-mono text-[10px] text-muted block mt-0.5">
                When on, new users must set up an authenticator app on first login. Admins always require 2FA regardless. Existing users without 2FA are not affected.
              </span>
            </span>
          </label>
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={save}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

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
