import { useMemo, useState } from "react";
import { FileCheck2, Plus, Rocket, Trash2 } from "lucide-react";
import { get } from "../api/client.ts";
import { approveCliAction, runCliAction, type CliActionWorkspace } from "../api/cli-actions.ts";
import { Btn, Card, Checkbox, confirm, showToast } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { serverProvisioningResourceId } from "../../../shared/server-provisioning.ts";

type Mode = "app" | "stack";
type WorkspaceFile = { path: string; content: string };
type Defaults = { server_type: string; location: string };

const APP_EXAMPLE = `{
  "name": "api",
  "build": {
    "repository": "https://github.com/example/api.git",
    "image": "registry.example.com/example/api"
  },
  "container_port": 3000,
  "volume": null
}`;

const STACK_EXAMPLE = `{
  "name": "platform",
  "apps": {
    "api": { "manifest": "apps/api.ocd.json" }
  },
  "services": {}
}`;

function parseJson(file: WorkspaceFile | undefined, label: string): Record<string, any> {
  if (!file) throw new Error(`${label} is missing from the workspace`);
  try {
    const value = JSON.parse(file.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export function DeployPage() {
  const [mode, setMode] = useState<Mode>("app");
  const [entry, setEntry] = useState(".ocd-deploy.json");
  const [files, setFiles] = useState<WorkspaceFile[]>([{ path: ".ocd-deploy.json", content: APP_EXAMPLE }]);
  const [commit, setCommit] = useState("");
  const [appName, setAppName] = useState("");
  const [vars, setVars] = useState("");
  const [configOnly, setConfigOnly] = useState(false);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [busy, setBusy] = useState<"validate" | "preview" | "deploy" | null>(null);
  const [output, setOutput] = useState("");
  const [previewedFingerprint, setPreviewedFingerprint] = useState("");

  const workspace = useMemo<CliActionWorkspace>(() => ({ entry, files }), [entry, files]);
  const fingerprint = useMemo(() => JSON.stringify({ mode, entry, files, commit, appName, vars, configOnly, allowUnknown }), [mode, entry, files, commit, appName, vars, configOnly, allowUnknown]);

  const switchMode = (next: Mode) => {
    setMode(next);
    const nextEntry = next === "app" ? ".ocd-deploy.json" : "ocd-stack.json";
    setEntry(nextEntry);
    setFiles([{ path: nextEntry, content: next === "app" ? APP_EXAMPLE : STACK_EXAMPLE }]);
    setOutput("");
    setPreviewedFingerprint("");
  };

  const updateFile = (index: number, patch: Partial<WorkspaceFile>) => {
    setFiles((current) => current.map((file, i) => {
      if (i !== index) return file;
      const updated = { ...file, ...patch };
      if (patch.path !== undefined && entry === file.path) setEntry(patch.path);
      return updated;
    }));
  };

  const actionValues = (extra: Record<string, string | boolean | string[] | undefined> = {}) => ({
    manifest: entry,
    commit,
    appName: mode === "app" ? appName.trim() || undefined : undefined,
    vars: vars.split(/\r?\n/).map((row) => row.trim()).filter(Boolean),
    configOnly,
    allowUnknown,
    ...extra,
  });

  const validate = async (quiet = false) => {
    if (!files.some((file) => file.path === entry)) throw new Error("Choose an entry file that exists in the workspace");
    const result = await runCliAction("manifest.validate", { manifest: entry, allowUnknown }, { workspace });
    setOutput(result.stdout.trim() || "Manifest is valid.");
    if (!quiet) showToast("Manifest is valid", "success");
  };

  const runValidation = async () => {
    setBusy("validate");
    try { await validate(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Validation failed", "error"); }
    finally { setBusy(null); }
  };

  const preview = async () => {
    if (mode !== "app") return;
    setBusy("preview");
    try {
      await validate(true);
      const result = await runCliAction("app.deploy", actionValues({ dryRun: true }), { workspace });
      setOutput(result.stdout.trim() || "No changes reported.");
      setPreviewedFingerprint(fingerprint);
      showToast("Deployment preview complete", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Preview failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const provisioningConfirmation = async (): Promise<string | undefined> => {
    const main = parseJson(files.find((file) => file.path === entry), "Entry manifest");
    if (mode === "app") {
      const apps = await get("/api/apps") as Array<{ name: string }>;
      const inferred = appName.trim() || String(main.suggested_app_name || main.build?.image?.split("/").pop() || "");
      if (!inferred) throw new Error("The app name could not be inferred from the manifest");
      if (apps.some((app) => app.name === inferred)) return undefined;
      const defaults = await get("/api/servers/provisioning-defaults") as Defaults;
      const reason = main.build ? `building and deploying app ${inferred}` : `deploying app ${inferred}`;
      return approveCliAction("create_server", "server_plan", serverProvisioningResourceId({
        serverType: defaults.server_type,
        location: defaults.location,
        pools: [String(main.placement_pool || "general")],
        reason,
      }));
    }

    const stackName = String(main.name || "");
    if (!stackName) throw new Error("Stack manifest must declare a name");
    const [apps, services] = await Promise.all([
      get("/api/apps") as Promise<Array<{ name: string }>>,
      get("/api/services") as Promise<Array<{ name: string }>>,
    ]);
    const appNames = new Set(apps.map((app) => app.name));
    const serviceNames = new Set(services.map((service) => service.name));
    const pools: string[] = [];
    for (const [key, ref] of Object.entries(main.apps || {}) as Array<[string, { manifest?: string }]>) {
      if (appNames.has(`${stackName}-${key}`)) continue;
      const child = parseJson(files.find((file) => file.path === ref.manifest), `Manifest for ${key}`);
      pools.push(String(child.placement_pool || "general"));
    }
    if (Object.keys(main.services || {}).some((key) => !serviceNames.has(`${stackName}-${key}`))) pools.unshift("general");
    if (pools.length === 0) return undefined;
    const defaults = await get("/api/servers/provisioning-defaults") as Defaults;
    return approveCliAction("create_server", "server_plan", serverProvisioningResourceId({
      serverType: defaults.server_type,
      location: defaults.location,
      pools,
      reason: `deploying stack ${stackName}`,
    }));
  };

  const deploy = async () => {
    if (!/^[a-f0-9]{7,64}$/i.test(commit.trim())) {
      showToast("Enter the exact 7-64 character Git commit", "error");
      return;
    }
    if (mode === "app" && previewedFingerprint !== fingerprint) {
      showToast("Preview the current app manifest before deploying", "error");
      return;
    }
    setBusy("deploy");
    try {
      await validate(true);
      const approved = await confirm(
        mode === "app" ? "Deploy app manifest" : "Deploy stack manifest",
        `${configOnly ? "Apply configuration from" : "Build and deploy"} ${entry} at commit ${commit.slice(0, 12)}? The CLI will follow the resulting operation.`,
        false,
      );
      if (!approved) return;
      const confirmationCode = await provisioningConfirmation();
      const result = await runCliAction(mode === "app" ? "app.deploy" : "stacks.deploy", actionValues(), { workspace, confirmationCode });
      setOutput(result.stdout.trim() || "Deployment completed.");
      showToast("Deployment completed", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Deployment failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const permission = mode === "app" ? "apps.deploy" : "stacks.deploy";
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="font-mono text-lg font-bold uppercase tracking-wider">Deploy</h1>
        <p className="mt-1 text-xs text-muted">Review manifests in the browser; execution still goes through the OCD CLI and operation engine.</p>
      </div>

      <div className="flex gap-2">
        <Btn variant={mode === "app" ? "primary" : "default"} onClick={() => switchMode("app")}>App manifest</Btn>
        <Btn variant={mode === "stack" ? "primary" : "default"} onClick={() => switchMode("stack")}>Stack manifest</Btn>
      </div>

      <Card className="p-4 space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Entry manifest</span><input value={entry} onChange={(event) => setEntry(event.target.value)} /></label>
          <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Exact Git commit</span><input value={commit} onChange={(event) => setCommit(event.target.value.trim())} placeholder="40-character SHA" /></label>
          {mode === "app" && <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">App name override</span><input value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="Use manifest name" /></label>}
          <label className="space-y-1"><span className="font-mono text-[9px] font-bold uppercase">Environment values · KEY=VALUE per line</span><textarea rows={3} value={vars} onChange={(event) => setVars(event.target.value)} /></label>
        </div>
        <div className="flex flex-wrap gap-4"><Checkbox checked={configOnly} onChange={setConfigOnly} label="Configuration only" /><Checkbox checked={allowUnknown} onChange={setAllowUnknown} label="Allow unknown keys" /></div>
      </Card>

      <div className="space-y-3">
        {files.map((file, index) => (
          <Card key={index} className="p-3 space-y-2">
            <div className="flex gap-2"><input className="flex-1" value={file.path} onChange={(event) => updateFile(index, { path: event.target.value })} placeholder="relative/manifest.json" /><Btn size="xs" variant="danger" disabled={files.length === 1} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><Trash2 size={12} /> Remove</Btn></div>
            <textarea className="font-mono text-[10px]" rows={Math.max(8, Math.min(22, file.content.split("\n").length + 1))} value={file.content} onChange={(event) => updateFile(index, { content: event.target.value })} spellCheck={false} />
          </Card>
        ))}
        <Btn size="xs" onClick={() => setFiles((current) => [...current, { path: "", content: "{}" }])}><Plus size={12} /> Add manifest file</Btn>
      </div>

      <PermissionGate permission={permission}>
        <div className="flex flex-wrap justify-end gap-2">
          <Btn loading={busy === "validate"} disabled={busy !== null} onClick={runValidation}><FileCheck2 size={13} /> Validate</Btn>
          {mode === "app" && <Btn loading={busy === "preview"} disabled={busy !== null || !commit} onClick={preview}>Preview changes</Btn>}
          <Btn variant="primary" loading={busy === "deploy"} disabled={busy !== null || !commit} onClick={deploy}><Rocket size={13} /> Deploy</Btn>
        </div>
      </PermissionGate>

      {output && <Card className="p-4"><h2 className="mb-2 font-mono text-[9px] font-bold uppercase">CLI result</h2><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-fg-dim">{output}</pre></Card>}
    </div>
  );
}
