import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, Btn, Table, Spinner, Field, Divider, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../../hooks/use-server-types.ts";
import { Users, Plus, Trash2, Shield, ShieldCheck, Key, ShieldAlert, Save, RefreshCw, Server as ServerIcon, Settings, Copy, Check, Hammer } from "lucide-react";
import type { PanelApp, DeploymentRecord } from "../../types.ts";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";
import { runCliAction } from "../../api/cli-actions.ts";

const stripAnsi = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

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

type BuildWorker = {
  id: number; name: string; status: string;
  worker_version: string; architecture: string; last_error: string;
  disk_free_bytes?: number; server: RunnerServer | null;
};

type BuildSource = {
  id: number; repository: string; branch: string; webhook_url: string;
  webhook_enabled: number; webhook_secret_configured: boolean;
  last_commit: string; last_status: string; last_error: string;
};

type Readiness = {
  ready: boolean;
  provider: { status: string; configured: boolean };
  defaults: { status: string; server_type: string; location: string };
  worker: { status: string; online: number; total: number };
  registry: { status: string; configured: boolean; scope: string };
  source: { status: string; configured: boolean; host: string };
  actions: Array<{ command: string; label: string }>;
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
    github_build_host: "", github_build_username: "", github_build_token: "",
  });
  const [registryConnected, setRegistryConnected] = useState(false);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<"registry" | "source" | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { serverTypes } = useServerTypes();

  // --- Panel ---
  const [panel, setPanel] = useState<PanelApp | null>(null);
  const [panelServer, setPanelServer] = useState<{ id: number; name: string; ipv4: string } | null>(null);
  const [panelDeployments, setPanelDeployments] = useState<DeploymentRecord[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelImage, setPanelImage] = useState("");

  // --- OCD BuildKit workers and repository webhooks ---
  const [runners, setRunners] = useState<BuildWorker[]>([]);
  const [buildSources, setBuildSources] = useState<BuildSource[]>([]);
  const [runnerServers, setRunnerServers] = useState<RunnerServer[]>([]);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [runnerForm, setRunnerForm] = useState({
    server_id: "", name: "", removal_token: "",
  });
  const [shownWebhook, setShownWebhook] = useState<{ url: string; secret: string } | null>(null);
  const availableRunnerServers = runnerServers.filter((server) =>
    server.status === "ready" &&
    !server.apps?.length &&
    server.id !== panelServer?.id &&
    !runners.some((runner) => runner.server?.id === server.id),
  );

  const refreshRunners = () => Promise.all([
    get("/api/runners").then((data) => setRunners(data || [])),
    get("/api/build-sources").then((data) => setBuildSources(data || [])),
    get("/api/servers").then((data) => {
      const servers = (data || []) as RunnerServer[];
      setRunnerServers(servers);
    }),
  ]).catch(() => {});
  const refreshReadiness = () => get("/api/readiness").then(setReadiness).catch(() => {});

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
          oci_registry_password: "",
          github_build_username: s.github_build_username ?? "",
          github_build_host: s.github_build_host ?? "",
          github_build_token: "",
        });
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    get("/api/admin/connections").then((connections) => {
      setRegistryConnected(connections.registry?.connected === true);
      setSourceConnected(connections.source?.connected === true);
    }).catch(() => {});
    refreshPanel();
    refreshRunners();
    refreshReadiness();
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
      const {
        oci_artifact_ref: _registryScope,
        oci_registry_username: _registryUsername,
        oci_registry_password: _registryToken,
        github_build_host: _sourceHost,
        github_build_username: _sourceUsername,
        github_build_token: _sourceToken,
        ...instanceSettings
      } = settingsForm;
      await put("/api/admin/settings", instanceSettings);
      showToast("Settings saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const connectRegistry = async () => {
    setConnectionBusy("registry");
    try {
      await runCliAction("registry.login", {
        scope: settingsForm.oci_artifact_ref,
        username: settingsForm.oci_registry_username,
        token: settingsForm.oci_registry_password,
      });
      setRegistryConnected(true);
      refreshReadiness();
      showToast("Registry connected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const disconnectRegistry = async () => {
    if (!await confirm("Disconnect Registry", "Remove the stored OCI registry credential? Existing deployed images keep running, but new builds and pulls may fail.", true)) return;
    setConnectionBusy("registry");
    try {
      await runCliAction("registry.logout", {}, { confirmed: true });
      setRegistryConnected(false);
      refreshReadiness();
      setSettingsForm((current) => ({ ...current, oci_artifact_ref: "", oci_registry_username: "", oci_registry_password: "" }));
      showToast("Registry disconnected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const connectSource = async () => {
    setConnectionBusy("source");
    try {
      await runCliAction("source.login", {
        host: settingsForm.github_build_host,
        username: settingsForm.github_build_username,
        token: settingsForm.github_build_token,
      });
      setSourceConnected(true);
      refreshReadiness();
      showToast("Private source access connected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const disconnectSource = async () => {
    if (!await confirm("Disconnect Source", "Remove the stored private Git checkout credential? Public repositories remain available.", true)) return;
    setConnectionBusy("source");
    try {
      await runCliAction("source.logout", {}, { confirmed: true });
      setSourceConnected(false);
      refreshReadiness();
      setSettingsForm((current) => ({ ...current, github_build_host: "", github_build_username: "", github_build_token: "" }));
      showToast("Source access disconnected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
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
    if (!runnerForm.server_id) {
      return showToast("Select a dedicated server", "error");
    }
    setRunnerBusy(true);
    try {
      await runCliAction("runners.install", {
        server: runnerForm.server_id,
        name: runnerForm.name || undefined,
        removalToken: runnerForm.removal_token || undefined,
      });
      setRunnerForm((current) => ({ ...current, removal_token: "" }));
      showToast("Build worker installed", "success");
      await refreshRunners();
      await refreshReadiness();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  const removeRunner = async (runner: BuildWorker) => {
    if (!await confirm("Remove Build Worker", `Remove ${runner.name} and release ${runner.server?.name || "its server"} back to its previous capacity pool?`, true)) return;
    setRunnerBusy(true);
    try {
      await runCliAction("runners.remove", { runner: String(runner.id) }, { confirmed: true });
      showToast("Build worker removed", "success");
      await refreshRunners();
      await refreshReadiness();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  const rotateWebhook = async (source: BuildSource) => {
    if (!await confirm("Rotate Webhook Secret", `Rotate the GitHub webhook secret for ${source.repository}#${source.branch}? The previous secret stops working immediately.`, true)) return;
    try {
      const result = await runCliAction("runners.webhook-secret", { source: String(source.id) }, { confirmed: true });
      const output = stripAnsi(result.stdout);
      const url = output.match(/^Payload URL:\s*(.+)$/m)?.[1]?.trim();
      const secret = output.match(/^Secret \(shown once\):\s*(.+)$/m)?.[1]?.trim();
      if (!url || !secret) throw new Error("CLI did not return the rotated webhook secret");
      setShownWebhook({ url, secret });
      await refreshRunners();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  if (loading || settingsLoading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in space-y-6">
      <div className="flex items-center gap-2">
        <Settings size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Admin</h1>
      </div>

      {readiness && <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deploy readiness</h3>
            <p className="font-mono text-[10px] text-muted mt-1">The CLI resolves missing build capacity during the first deploy.</p>
          </div>
          <Btn size="xs" onClick={refreshReadiness}><RefreshCw size={11} /> Recheck</Btn>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {[
            ["Provider", readiness.provider.configured ? "Connected" : "Optional"],
            ["Capacity defaults", readiness.defaults.server_type ? `${readiness.defaults.server_type} / ${readiness.defaults.location}` : "Missing"],
            ["Build worker", `${readiness.worker.online} online`],
            ["Registry", readiness.registry.configured ? readiness.registry.scope : "Not connected"],
          ].map(([label, value]) => <div key={label} className="border-2 border-fg/30 p-3">
            <div className="font-mono text-[8px] text-muted uppercase">{label}</div>
            <div className="font-mono text-[10px] font-bold mt-1 break-all">{value}</div>
          </div>)}
        </div>
        {readiness.actions.length > 0 && <div className="bg-alt border-2 border-fg p-3 space-y-1">
          <div className="font-mono text-[9px] font-bold uppercase">Next actions</div>
          {readiness.actions.map((action) => <div key={action.command} className="font-mono text-[10px]">
            {action.label}: <code className="font-bold select-all">{action.command}</code>
          </div>)}
        </div>}
      </Card>}

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
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={saveSettings}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

      {/* Build connections are explicit capabilities, not generic settings. */}
      <Card className="p-5 space-y-4">
        <div>
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Build connections</h3>
          <p className="font-mono text-[10px] text-muted mt-1">
            OCD stores these credentials encrypted and sends them only to the exact source host or OCI namespace configured here.
          </p>
        </div>

        <div className="border-2 border-fg p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] font-bold uppercase">OCI registry</div>
              <div className="font-mono text-[9px] text-muted">Any compatible OCI registry: GHCR, GitLab, Docker Hub, Quay, Harbor, or self-hosted.</div>
            </div>
            <span className={`font-mono text-[9px] font-bold uppercase px-2 py-1 border-2 border-fg ${registryConnected ? "bg-green-200" : "bg-yellow-200"}`}>
              {registryConnected ? "Connected" : "Not connected"}
            </span>
          </div>
          <Field label="Repository namespace" align="start" hint="Credential boundary, for example registry.example.com/team. It is never sent to another namespace on the same registry.">
            <input type="text" value={settingsForm.oci_artifact_ref} onChange={setS("oci_artifact_ref")} placeholder="registry.example.com/team" />
          </Field>
          <Field label="Username">
            <input type="text" value={settingsForm.oci_registry_username} onChange={setS("oci_registry_username")} placeholder="acme" />
          </Field>
          <Field label={registryConnected ? "New token (only to update)" : "Password / token"}>
            <input type="password" value={settingsForm.oci_registry_password} onChange={setS("oci_registry_password")} placeholder={registryConnected ? "Leave empty to keep current connection" : "Registry password or token"} />
          </Field>
          <div className="flex gap-2">
            <Btn variant="primary" loading={connectionBusy === "registry"} disabled={!settingsForm.oci_registry_password} onClick={connectRegistry}>
              <Key size={13} /> {registryConnected ? "Update connection" : "Connect registry"}
            </Btn>
            {registryConnected && <Btn variant="danger" disabled={connectionBusy !== null} onClick={disconnectRegistry}><Trash2 size={12} /> Disconnect</Btn>}
          </div>
        </div>

        <div className="border-2 border-fg p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] font-bold uppercase">Private source access</div>
              <div className="font-mono text-[9px] text-muted">Any HTTPS Git host. Public repositories need no source credential.</div>
            </div>
            <span className={`font-mono text-[9px] font-bold uppercase px-2 py-1 border-2 border-fg ${sourceConnected ? "bg-green-200" : "bg-alt"}`}>
              {sourceConnected ? "Connected" : "Public only"}
            </span>
          </div>
          <Field label="Git host">
            <input type="text" value={settingsForm.github_build_host} onChange={setS("github_build_host")} placeholder="git.example.com" />
          </Field>
          <Field label="Checkout username" align="start" hint="Provider-specific; GitHub commonly uses x-access-token.">
            <input type="text" value={settingsForm.github_build_username} onChange={setS("github_build_username")} placeholder="git-user" />
          </Field>
          <Field label={sourceConnected ? "New read-only token (only to update)" : "Read-only token"}>
            <input type="password" value={settingsForm.github_build_token} onChange={setS("github_build_token")} placeholder={sourceConnected ? "Leave empty to keep current connection" : "Token for private checkout"} />
          </Field>
          <div className="flex gap-2">
            <Btn variant="primary" loading={connectionBusy === "source"} disabled={!settingsForm.github_build_host || !settingsForm.github_build_username || !settingsForm.github_build_token} onClick={connectSource}>
              <Key size={13} /> {sourceConnected ? "Update connection" : "Connect source"}
            </Btn>
            {sourceConnected && <Btn variant="danger" disabled={connectionBusy !== null} onClick={disconnectSource}><Trash2 size={12} /> Disconnect</Btn>}
          </div>
        </div>
      </Card>

      {/* OCD BuildKit workers */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider flex items-center gap-2">
            <Hammer size={12} /> OCD build workers
          </h3>
          <Btn size="xs" onClick={refreshRunners}><RefreshCw size={11} /> Refresh</Btn>
        </div>
        <p className="font-mono text-[10px] text-muted">
          OCD checks out exact commits from any compatible Git host, builds and pushes to any compatible OCI registry, then deploys the immutable digest. GitHub push webhooks are the current automatic trigger integration.
        </p>

        {runners.length > 0 && (
          <Table headers={["Worker", "Server", "Status", "Version", "Disk", ""]}>
            {runners.map((runner) => (
              <tr key={runner.id}>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.name}</td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.server?.name || "Missing"}</td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.status}{runner.last_error && <div className="text-red-600 max-w-xs break-words">{runner.last_error}</div>}</td>
                <td className="py-2 px-3 font-mono text-[10px]">{runner.worker_version || "—"}<div className="text-muted">{runner.architecture || "—"}</div></td>
                <td className="py-2 px-3"><Btn size="xs" variant="danger" disabled={runnerBusy} onClick={() => removeRunner(runner)}><Trash2 size={11} /></Btn></td>
              </tr>
            ))}
          </Table>
        )}

        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Dedicated server" align="start" hint="The backend rejects the panel host and any server with apps or services.">
            <NeoSelect
              value={runnerForm.server_id}
              onChange={(serverId) => setRunnerForm((current) => ({ ...current, server_id: serverId }))}
              options={availableRunnerServers.map((server) => ({
                value: String(server.id),
                label: `${server.name} (${server.pool || "general"})`,
              }))}
              placeholder="Select server"
            />
          </Field>
          <Field label="Worker name" align="start" hint="Optional; defaults to ocd-<server>.">
            <input value={runnerForm.name} onChange={(event) => setRunnerForm((current) => ({ ...current, name: event.target.value }))} placeholder="ocd-build-1" />
          </Field>
          <Field label="Legacy runner removal token" align="start" hint="Only needed once when converting an existing GitHub Actions runner. New workers leave this empty.">
            <input type="password" value={runnerForm.removal_token} onChange={(event) => setRunnerForm((current) => ({ ...current, removal_token: event.target.value }))} placeholder="Optional conversion token" />
          </Field>
        </div>
        <Btn variant="primary" loading={runnerBusy} onClick={installRunner}><Hammer size={13} /> Install build worker</Btn>

        {buildSources.length > 0 && <>
          <Divider />
          <div className="font-mono text-[9px] font-bold uppercase">GitHub push webhooks</div>
          <Table headers={["Source", "Branch", "Status", "Webhook", ""]}>
            {buildSources.map((source) => <tr key={source.id}>
              <td className="py-2 px-3 font-mono text-[10px] break-all">{source.repository}</td>
              <td className="py-2 px-3 font-mono text-[10px]">{source.branch}</td>
              <td className="py-2 px-3 font-mono text-[10px]">{source.last_status || "idle"}{source.last_error && <div className="text-red-600 max-w-xs break-words">{source.last_error}</div>}</td>
              <td className="py-2 px-3 font-mono text-[10px]">{source.webhook_secret_configured ? "ready" : "missing"}</td>
              <td className="py-2 px-3"><Btn size="xs" onClick={() => rotateWebhook(source)}><Key size={11} /> Rotate</Btn></td>
            </tr>)}
          </Table>
        </>}
        {shownWebhook && <div className="border-2 border-fg p-3 space-y-2">
          <div className="font-mono text-[9px] font-bold uppercase">Webhook secret — shown once</div>
          <div className="font-mono text-[10px] break-all"><strong>URL:</strong> {shownWebhook.url}</div>
          <div className="font-mono text-[10px] break-all"><strong>Secret:</strong> {shownWebhook.secret}</div>
          <div className="font-mono text-[9px] text-muted">GitHub webhook content type: application/json; event: push only.</div>
        </div>}
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
