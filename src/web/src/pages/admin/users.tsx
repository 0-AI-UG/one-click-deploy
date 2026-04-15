import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, Btn, Table, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../../hooks/use-server-types.ts";
import { Users, Plus, Trash2, Shield, ShieldCheck, Key, ShieldAlert, Save, RefreshCw, Server as ServerIcon, Settings, Copy, Check } from "lucide-react";
import type { PanelApp, DeploymentRecord } from "../../types.ts";

function GitHubOAuthSettings({ form, setS }: { form: Record<string, string>; setS: (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  const [copied, setCopied] = useState(false);
  const callbackUrl = `${window.location.origin}/api/auth/github/callback`;

  const copyUrl = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pt-2 space-y-3">
      <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">GitHub OAuth</h3>
      <div>
        <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Callback URL</label>
        <div className="flex items-center gap-2 bg-alt border-2 border-fg px-3 py-2">
          <code className="font-mono text-[10px] text-fg flex-1 select-all truncate">{callbackUrl}</code>
          <button onClick={copyUrl} className="text-muted hover:text-fg transition-colors shrink-0">
            {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Client ID</label>
          <input type="text" value={form.github_oauth_client_id} onChange={setS("github_oauth_client_id")} placeholder="Ov23li..." />
        </div>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Client Secret</label>
          <input type="password" value={form.github_oauth_client_secret} onChange={setS("github_oauth_client_secret")} placeholder="Client secret" />
        </div>
      </div>
    </div>
  );
}

type User = {
  id: string; username: string; isAdmin: boolean; totpEnabled: boolean;
  webauthnEnabled: boolean; permissions: string[]; createdAt: string;
};

export function UsersPage() {
  // --- Users ---
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [require2fa, setRequire2fa] = useState(true);
  const [savingRequire2fa, setSavingRequire2fa] = useState(false);

  // --- Instance Settings ---
  const [settingsForm, setSettingsForm] = useState({
    provider_token: "",
    github_oauth_client_id: "", github_oauth_client_secret: "",
    dns_zone_id: "", default_server_type: "", default_location: "",
  });
  const [providerName, setProviderName] = useState("Provider");
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { serverTypes } = useServerTypes();

  // --- Panel ---
  const [panel, setPanel] = useState<PanelApp | null>(null);
  const [panelServer, setPanelServer] = useState<{ name: string; ipv4: string } | null>(null);
  const [panelDeployments, setPanelDeployments] = useState<DeploymentRecord[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);

  const loadUsers = async () => {
    try {
      const res = await get("/api/admin/users");
      setUsers(res.users);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const refreshPanel = () => {
    get("/api/admin/panel")
      .then((data) => { setPanel(data.panel); setPanelServer(data.server); })
      .catch(() => {});
    get("/api/admin/panel/deployments")
      .then((data) => setPanelDeployments(data || []))
      .catch(() => {});
  };

  useEffect(() => {
    loadUsers();
    get("/api/admin/settings")
      .then((s) => {
        setRequire2fa(s.require_2fa !== false);
        if (s.provider?.name) setProviderName(s.provider.name);
        setSettingsForm({
          provider_token: s.provider_token ?? "",
          github_oauth_client_id: s.github_oauth_client_id ?? "",
          github_oauth_client_secret: s.github_oauth_client_secret ?? "",
          dns_zone_id: s.dns_zone_id ?? "",
          default_server_type: s.default_server_type ?? "",
          default_location: s.default_location ?? "",
        });
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    refreshPanel();
  }, []);

  useEffect(() => {
    if (serverTypes.length > 0 && !settingsForm.default_server_type) {
      const first = serverTypes[0];
      setSettingsForm((f) => ({ ...f, default_server_type: first.name, default_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes, settingsForm.default_server_type]);

  const setS = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setSettingsForm((f) => ({ ...f, [k]: e.target.value }));

  const toggleRequire2fa = async (next: boolean) => {
    setSavingRequire2fa(true);
    setRequire2fa(next);
    try {
      await put("/api/admin/settings", { require_2fa: next });
      showToast(next ? "2FA now required for new users" : "2FA no longer required", "success");
    } catch (err: any) {
      setRequire2fa(!next);
      showToast(err.message, "error");
    } finally {
      setSavingRequire2fa(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) return showToast("Username and password required", "error");
    setCreating(true);
    try {
      await post("/api/admin/users", form);
      showToast("User created", "success");
      setShowCreate(false);
      setForm({ username: "", password: "" });
      loadUsers();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user: User) => {
    if (!await confirm("Delete User", `Delete user "${user.username}"? This cannot be undone.`, true)) return;
    try {
      await del(`/api/admin/users/${user.id}`);
      showToast("User deleted", "success");
      loadUsers();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await put("/api/admin/settings", settingsForm);
      showToast("Settings saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const redeployPanelNow = async () => {
    if (!await confirm(
      "Redeploy Panel",
      "The panel will become unavailable for ~30–60s while it rebuilds. You will need to reload this page once it comes back.",
      true,
    )) return;
    setPanelBusy(true);
    try {
      const result = await post("/api/admin/panel/redeploy");
      if (result?.ok) {
        showToast("Panel rebuild dispatched", "success");
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

  if (loading || settingsLoading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 animate-fade-in space-y-6">
      <div className="flex items-center gap-2">
        <Settings size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Admin</h1>
      </div>

      {/* Instance Settings */}
      <Card className="p-5 space-y-4">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">API Tokens</h3>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">{providerName} API Token</label>
          <input type="password" value={settingsForm.provider_token} onChange={setS("provider_token")} placeholder="Enter token" />
        </div>
        <GitHubOAuthSettings form={settingsForm} setS={setS} />

        <div className="pt-2">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Defaults</h3>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID</label>
            <input type="text" value={settingsForm.dns_zone_id} onChange={setS("dns_zone_id")} placeholder="DNS Zone ID" />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
              <NeoSelect
                value={settingsForm.default_server_type}
                onChange={(v) => {
                  setSettingsForm((f) => {
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
                value={settingsForm.default_location}
                onChange={(v) => setSettingsForm((f) => ({ ...f, default_location: v }))}
                options={locationOptions(serverTypes, settingsForm.default_server_type)}
              />
            </div>
          </div>
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={saveSettings}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

      {/* Panel */}
      {panel && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-2">
              <ServerIcon size={12} /> Panel (self-hosted)
            </h3>
            <span
              className={`font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg ${
                panel.status === "running" ? "bg-green-200" : panel.status === "error" ? "bg-red-200" : "bg-yellow-200"
              }`}
            >
              {panel.status}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
            <div className="text-muted">Domain</div>
            <div className="text-fg break-all">
              <a href={`https://${panel.domain}`} target="_blank" rel="noreferrer" className="underline">{panel.domain}</a>
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
          </div>

          <div className="pt-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[11px] text-fg font-bold">Auto-update from {panel.git_branch}</div>
                <div className="font-mono text-[10px] text-muted mt-0.5">
                  GitHub webhook on each push to <span className="text-fg">{panel.git_branch}</span>.
                </div>
              </div>
              <Btn
                variant={panel.webhook_enabled ? "default" : "primary"}
                loading={panelBusy}
                onClick={async () => {
                  setPanelBusy(true);
                  try {
                    const path = panel.webhook_enabled ? "/api/admin/panel/webhook/disable" : "/api/admin/panel/webhook/enable";
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
            <div className="pt-1">
              <h4 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Recent deployments</h4>
              <div className="space-y-1 text-[11px] font-mono max-h-48 overflow-y-auto">
                {panelDeployments.slice(0, 10).map((d) => (
                  <div key={d.id} className="flex justify-between gap-2">
                    <span className="text-muted truncate">{new Date(d.created_at + "Z").toLocaleString()}</span>
                    <span className="text-fg">{d.source}</span>
                    <span className="text-muted truncate" title={d.git_commit}>{d.git_commit?.slice(0, 12) || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Users */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Users</h3>
            <span className="font-mono text-[9px] text-muted">{users.length}</span>
          </div>
          <Btn variant="primary" onClick={() => setShowCreate(!showCreate)}>
            <Plus size={13} /> Create User
          </Btn>
        </div>

        {showCreate && (
          <div className="mb-4 p-4 border-2 border-fg bg-alt animate-slide-up">
            <form onSubmit={handleCreate} className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
                <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username" required />
              </div>
              <div className="flex-1">
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Password</label>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 8 characters" required />
              </div>
              <Btn type="submit" variant="primary" loading={creating}>Create</Btn>
            </form>
          </div>
        )}

        <div className="mb-4 p-3 border-2 border-fg/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert size={13} className="text-fg" />
              <span className="font-mono text-[10px] text-fg font-bold">Require 2FA for new users</span>
            </div>
            <label className="inline-flex items-center cursor-pointer">
              <input type="checkbox" checked={require2fa} disabled={savingRequire2fa} onChange={(e) => toggleRequire2fa(e.target.checked)} />
            </label>
          </div>
        </div>

        <Table headers={["Username", "Role", "2FA", "Permissions", "Created", ""]}>
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-alt/50 cursor-pointer" onClick={() => { window.location.hash = `#/admin/${u.id}`; }}>
              <td className="py-2.5 px-3">
                <span className="text-fg font-bold">{u.username}</span>
              </td>
              <td className="py-2.5 px-3">
                {u.isAdmin ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase bg-accent-amber border-2 border-fg px-1.5 py-0.5 text-fg shadow-neo-sm">
                    <ShieldCheck size={10} /> Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase bg-alt border-2 border-fg px-1.5 py-0.5 text-fg-dim shadow-neo-sm">
                    <Shield size={10} /> User
                  </span>
                )}
              </td>
              <td className="py-2.5 px-3">
                {u.totpEnabled && u.webauthnEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">Both</span>
                ) : u.totpEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">TOTP</span>
                ) : u.webauthnEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">Passkey</span>
                ) : (
                  <span className="text-muted text-[9px] font-mono uppercase">None</span>
                )}
              </td>
              <td className="py-2.5 px-3">
                <span className="inline-flex items-center gap-1 text-[9px] font-mono text-fg-dim">
                  <Key size={10} /> {u.isAdmin ? "All" : `${u.permissions.length}`}
                </span>
              </td>
              <td className="py-2.5 px-3 text-muted font-mono text-[10px]">{new Date(u.createdAt + "Z").toLocaleDateString()}</td>
              <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                {!u.isAdmin && (
                  <Btn size="xs" variant="danger" onClick={() => handleDelete(u)}>
                    <Trash2 size={11} />
                  </Btn>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
