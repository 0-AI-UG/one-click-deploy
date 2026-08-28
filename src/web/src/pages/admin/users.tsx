import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, Btn, Table, Spinner, Field, Divider, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../../hooks/use-server-types.ts";
import { Users, Plus, Trash2, Shield, ShieldCheck, Key, ShieldAlert, Save, RefreshCw, Server as ServerIcon, Settings, Copy, Check, Hammer } from "lucide-react";
import type { PanelApp, DeploymentRecord } from "../../types.ts";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";

function GitHubOAuthSettings({ form, setS }: {
  form: { github_oauth_client_id: string; github_oauth_client_secret: string };
  setS: (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const callbackUrl = `${window.location.origin}/api/auth/github/callback`;

  const copyUrl = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pt-2">
      <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">GitHub OAuth</h3>
      <Field label="Callback URL" align="start">
        <div className="flex items-center gap-2 bg-alt border-2 border-fg px-3 py-2">
          <code className="font-mono text-[10px] text-fg flex-1 select-all truncate">{callbackUrl}</code>
          <button onClick={copyUrl} className="text-muted hover:text-fg transition-colors shrink-0">
            {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
          </button>
        </div>
      </Field>
      <Field label="Client ID">
        <input type="text" value={form.github_oauth_client_id} onChange={setS("github_oauth_client_id")} placeholder="Ov23li..." />
      </Field>
      <Field label="Client Secret">
        <input type="password" value={form.github_oauth_client_secret} onChange={setS("github_oauth_client_secret")} placeholder="Client secret" />
      </Field>
    </div>
  );
}

type User = {
  id: string; username: string; isAdmin: boolean;
  webauthnEnabled: boolean; permissions: string[]; createdAt: string;
};

type RunnerServer = {
  id: number; name: string; ipv4: string; status: string; pool: string;
  apps?: Array<{ id: number; name: string }>;
};

type GitHubRunner = {
  id: number; name: string; scope_url: string; labels: string; status: string;
  runner_version: string; architecture: string; last_error: string;
  disk_free_bytes?: number; server: RunnerServer | null;
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
    hetzner_api_token: "",
    github_oauth_client_id: "", github_oauth_client_secret: "",
    default_domain_suffix: "", default_server_type: "", default_location: "",
    oci_artifact_ref: "", oci_registry_username: "", oci_registry_password: "",
  });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { serverTypes } = useServerTypes();

  // --- Panel ---
  const [panel, setPanel] = useState<PanelApp | null>(null);
  const [panelServer, setPanelServer] = useState<{ id: number; name: string; ipv4: string } | null>(null);
  const [panelDeployments, setPanelDeployments] = useState<DeploymentRecord[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelImage, setPanelImage] = useState("");

  // --- GitHub Actions build runners ---
  const [runners, setRunners] = useState<GitHubRunner[]>([]);
  const [runnerServers, setRunnerServers] = useState<RunnerServer[]>([]);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [runnerForm, setRunnerForm] = useState({
    server_id: "", scope_url: "", name: "", registration_token: "",
  });
  const [runnerRemovalToken, setRunnerRemovalToken] = useState("");
  const availableRunnerServers = runnerServers.filter((server) =>
    server.status === "ready" &&
    !server.apps?.length &&
    server.id !== panelServer?.id &&
    !runners.some((runner) => runner.server?.id === server.id),
  );

  const refreshRunners = () => Promise.all([
    get("/api/runners").then((data) => setRunners(data || [])),
    get("/api/servers").then((data) => {
      const servers = (data || []) as RunnerServer[];
      setRunnerServers(servers);
    }),
  ]).catch(() => {});

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
      .then((data) => {
        setPanel(data.panel ? { ...data.panel, dns_instruction: data.dns_instruction } : null);
        setPanelServer(data.server);
      })
      .catch(() => {});
    get("/api/admin/panel/deployments")
      .then((data) => {
        const deployments = (data || []) as DeploymentRecord[];
        setPanelDeployments(deployments);
        const currentImage = deployments.find((deployment) => deployment.status === "deployed")?.image_tag;
        if (currentImage) setPanelImage(currentImage);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadUsers();
    get("/api/admin/settings")
      .then((s) => {
        setRequire2fa(s.require_2fa !== false);
        setSettingsForm({
          hetzner_api_token: s.hetzner_api_token ?? "",
          github_oauth_client_id: s.github_oauth_client_id ?? "",
          github_oauth_client_secret: s.github_oauth_client_secret ?? "",
          default_domain_suffix: s.default_domain_suffix ?? "",
          default_server_type: s.default_server_type ?? "",
          default_location: s.default_location ?? "",
          oci_artifact_ref: s.oci_artifact_ref ?? "",
          oci_registry_username: s.oci_registry_username ?? "",
          oci_registry_password: s.oci_registry_password ?? "",
        });
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    refreshPanel();
    refreshRunners();
  }, []);

  useEffect(() => {
    if (!runners.some((runner) => ["installing", "removing"].includes(runner.status))) return;
    const timer = window.setInterval(refreshRunners, 5000);
    return () => window.clearInterval(timer);
  }, [runners]);

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
    const image = panelImage.trim();
    if (!/@sha256:[0-9a-f]{64}$/i.test(image)) {
      showToast("Enter an immutable image reference ending in @sha256:<64 hex characters>", "error");
      return;
    }
    if (!await confirm(
      "Release Panel Image",
      `Deploy ${image} to the panel? The panel will briefly become unavailable and you will need to reload this page once it comes back.`,
      true,
    )) return;
    setPanelBusy(true);
    try {
      const result = await post("/api/admin/panel/redeploy", { image });
      if (result?.ok) {
        showToast("Panel release dispatched", "success");
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

  const installRunner = async () => {
    if (!runnerForm.server_id || !runnerForm.scope_url || !runnerForm.registration_token) {
      return showToast("Server, GitHub scope and registration token are required", "error");
    }
    setRunnerBusy(true);
    try {
      const result = await post("/api/runners", {
        ...runnerForm,
        server_id: Number(runnerForm.server_id),
        name: runnerForm.name || undefined,
      });
      setRunnerForm((current) => ({ ...current, registration_token: "" }));
      showToast(`Runner installation queued as operation #${result.op_id}`, "success");
      await refreshRunners();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  const removeRunner = async (runner: GitHubRunner) => {
    if (!runnerRemovalToken) return showToast("Paste a fresh GitHub removal token first", "error");
    if (!await confirm("Remove Build Runner", `Deregister ${runner.name} and release ${runner.server?.name || "its server"} back to its previous capacity pool?`, true)) return;
    setRunnerBusy(true);
    try {
      const result = await del(`/api/runners/${runner.id}`, { removal_token: runnerRemovalToken });
      setRunnerRemovalToken("");
      showToast(`Runner removal queued as operation #${result.op_id}`, "success");
      await refreshRunners();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  if (loading || settingsLoading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in space-y-6">
      <div className="flex items-center gap-2">
        <Settings size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Admin</h1>
      </div>

      {/* Instance Settings */}
      <Card className="p-5 space-y-4">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Optional Infrastructure Provider</h3>
        <Field label="Hetzner Cloud API Token" align="start" hint="Optional. Configure this only when OCD should create and own Hetzner servers and volumes. Leave empty to use connected servers.">
          <input type="password" value={settingsForm.hetzner_api_token} onChange={setS("hetzner_api_token")} placeholder="Not configured" />
        </Field>
        <Divider />
        <GitHubOAuthSettings form={settingsForm} setS={setS} />
        <Divider />

        <div className="pt-2">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Defaults</h3>
          <Field label="Default Domain Suffix" align="start" hint="OCD displays required DNS records but never modifies DNS.">
            <input type="text" value={settingsForm.default_domain_suffix} onChange={setS("default_domain_suffix")} placeholder="apps.example.com" />
          </Field>
          <Field label="Default Server Type">
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
          </Field>
          <Field label="Default Location">
            <NeoSelect
              value={settingsForm.default_location}
              onChange={(v) => setSettingsForm((f) => ({ ...f, default_location: v }))}
              options={locationOptions(serverTypes, settingsForm.default_server_type)}
            />
          </Field>
          <Field label="OCI registry username">
            <input type="text" value={settingsForm.oci_registry_username} onChange={setS("oci_registry_username")} placeholder="ocd" />
          </Field>
          <Field label="OCI repository" align="start" hint="Repository prefix whose registry may receive the credentials below, for example ghcr.io/acme/apps.">
            <input type="text" value={settingsForm.oci_artifact_ref} onChange={setS("oci_artifact_ref")} placeholder="ghcr.io/acme/apps" />
          </Field>
          <Field label="OCI registry password/token">
            <input type="password" value={settingsForm.oci_registry_password} onChange={setS("oci_registry_password")} placeholder="Registry password or token" />
          </Field>
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={saveSettings}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

      {/* GitHub Actions runners */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-2">
            <Hammer size={12} /> GitHub Actions build runners
          </h3>
          <Btn size="xs" onClick={refreshRunners}><RefreshCw size={11} /> Refresh</Btn>
        </div>
        <p className="font-mono text-[10px] text-muted">
          OCD installs GitHub's official runner on an empty dedicated server. GitHub checks out and builds; OCD still deploys only immutable registry images.
        </p>

        {runners.length > 0 && (
          <Table headers={["Runner", "Server", "Scope", "Status", "Version", ""]}>
            {runners.map((runner) => (
              <tr key={runner.id}>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.name}<div className="text-muted">{runner.labels}</div></td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.server?.name || "Missing"}</td>
                <td className="py-2 px-3 font-mono text-[10px] break-all">{runner.scope_url.replace("https://github.com/", "")}</td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.status}{runner.last_error && <div className="text-red-600 max-w-xs break-words">{runner.last_error}</div>}</td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.runner_version || "—"}<div className="text-muted">{runner.architecture || "—"}</div></td>
                <td className="py-2 px-3"><Btn size="xs" variant="danger" disabled={runnerBusy} onClick={() => removeRunner(runner)}><Trash2 size={11} /></Btn></td>
              </tr>
            ))}
          </Table>
        )}

        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Dedicated server" align="start" hint="The backend rejects the panel host and any server with apps or services.">
            <select value={runnerForm.server_id} onChange={(event) => setRunnerForm((current) => ({ ...current, server_id: event.target.value }))}>
              <option value="">Select server</option>
              {availableRunnerServers.map((server) => <option key={server.id} value={server.id}>{server.name} ({server.pool || "general"})</option>)}
            </select>
          </Field>
          <Field label="GitHub scope URL" align="start" hint="Organization or one repository.">
            <input value={runnerForm.scope_url} onChange={(event) => setRunnerForm((current) => ({ ...current, scope_url: event.target.value }))} placeholder="https://github.com/OWNER" />
          </Field>
          <Field label="Runner name" align="start" hint="Optional; defaults to ocd-<server>.">
            <input value={runnerForm.name} onChange={(event) => setRunnerForm((current) => ({ ...current, name: event.target.value }))} placeholder="ocd-build-1" />
          </Field>
          <Field label="One-hour registration token" align="start" hint="GitHub Settings → Actions → Runners → New self-hosted runner. It is never retained after installation.">
            <input type="password" value={runnerForm.registration_token} onChange={(event) => setRunnerForm((current) => ({ ...current, registration_token: event.target.value }))} placeholder="Registration token" />
          </Field>
        </div>
        <Btn variant="primary" loading={runnerBusy} onClick={installRunner}><Hammer size={13} /> Install runner</Btn>

        <div className="border-2 border-fg/20 p-3 space-y-2">
          <div className="font-mono text-[9px] font-bold uppercase">Workflow selector</div>
          <code className="font-mono text-[10px] select-all">runs-on: [self-hosted, ocd-builder]</code>
          <Field label="Removal token" align="start" hint="Only needed when removing a runner; obtain it from GitHub runner settings.">
            <input type="password" value={runnerRemovalToken} onChange={(event) => setRunnerRemovalToken(event.target.value)} placeholder="Fresh removal token" />
          </Field>
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
            <div className="text-muted">Image</div>
            <div className="text-fg break-all">{panelDeployments.find((deployment) => deployment.status === "deployed")?.image_tag || panel.image_ref || "—"}</div>
            <div className="text-muted">Volume</div>
            <div className="text-fg break-all">{panel.volume_mount || "—"}</div>
          </div>

          {panel.dns_instruction && <DnsInstructionView value={panel.dns_instruction} />}

          <PermissionGate permission="panel.manage">
            <div className="pt-1 space-y-2">
              <Field label="Next immutable image" align="start" hint="Build and publish this image in CI, then paste its digest-qualified reference here.">
                <input type="text" value={panelImage} onChange={(event) => setPanelImage(event.target.value)} placeholder="ghcr.io/owner/ocd@sha256:..." />
              </Field>
              <Btn variant="primary" loading={panelBusy} onClick={redeployPanelNow}>
                <RefreshCw size={13} /> Release panel image
              </Btn>
            </div>
          </PermissionGate>

          {panelDeployments.length > 0 && (
            <div className="pt-1">
              <h4 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-2">Recent deployments</h4>
              <div className="space-y-1 text-[11px] font-mono max-h-48 overflow-y-auto">
                {panelDeployments.slice(0, 10).map((d) => (
                  <div key={d.id} className="flex justify-between gap-2">
                    <span className="text-muted truncate">{new Date(d.created_at + "Z").toLocaleString()}</span>
                    <span className="text-fg">{d.source}</span>
                    <span className="text-muted truncate" title={d.image_tag}>{d.image_tag?.split("@sha256:").pop()?.slice(0, 12) || "—"}</span>
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
                {u.webauthnEnabled ? (
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
