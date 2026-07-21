import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, showToast } from "../../components/ui.tsx";
import { Rocket, RotateCcw, X, Save, Loader2, Database, ChevronDown, Settings2, CheckCircle2, Boxes, Lock } from "lucide-react";
import { RepoSection } from "./repo-section.tsx";
import { ManifestSection } from "./manifest-section.tsx";
import { ReceiptSection } from "./receipt-section.tsx";
import { EnvSection } from "./env-section.tsx";
import { AdvancedSection } from "./advanced-section.tsx";
import { ServicesGridSection } from "./services-grid.tsx";
import { StackSection, useStackForm } from "./stack-section.tsx";
import { useHasPermission } from "../../stores/auth.ts";
import { mergeEnv } from "../../../../shared/env-merge.ts";
import type { IntrospectResult, AppIntrospect, ManifestEnvDef, FormState } from "./types.ts";
import type { DeployBody, EnvironmentData } from "../../types.ts";

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[9px] uppercase tracking-wider text-muted shrink-0">{label}</span>
      <span className="text-fg truncate text-right">{value}</span>
    </div>
  );
}

// Stack header shown once a repo resolves to a stack: the stack name, a branch
// selector (re-introspects on change), and an Advanced disclosure holding the
// manifest-path override for repos whose stack file isn't the auto-detected one.
function StackAdvanced({
  stackName, branch, branches, onBranchChange,
  stackPath, detectedPath, onStackPathChange, open, onToggle,
}: {
  stackName: string;
  branch: string;
  branches: string[];
  onBranchChange: (b: string) => void;
  stackPath: string;
  detectedPath: string;
  onStackPathChange: (p: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const inputCls =
    "bg-bg border-2 border-fg/40 px-2 py-1 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-fg";
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Boxes size={14} className="text-fg" />
        <span className="font-mono text-[13px] font-bold text-fg uppercase">{stackName}</span>
        {branches.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted">Branch</span>
            <select value={branch} onChange={(e) => onBranchChange(e.target.value)} className={`${inputCls} cursor-pointer`}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto inline-flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim hover:text-fg"
        >
          <Settings2 size={11} /> Advanced
          <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted">Manifest</span>
          <input
            value={stackPath}
            placeholder={detectedPath}
            onChange={(e) => onStackPathChange(e.target.value)}
            className={`${inputCls} w-64`}
          />
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM: FormState = {
  app_name: "",
  git_repo: "",
  git_branch: "",
  domain: "",
  container_port: "3000",
  volume_size: "",
  volume_path: "/data",
  dockerfile_path: "",
  docker_context: "",
  webhook_enabled: false,
  webhook_branch: "main",
  webhook_path: "",
  webhook_wait_for_ci: false,
  auth_password: "",
  replicas: "1",
  public: true,
  extra_volumes: [],
  server_id: "",
  memory_mb: "",
  cpu_limit: "",
  health_check: true,
  internal_protocol: "http",
  sticky: false,
  rate_limit_rps: "",
  ip_allowlist: "",
  health_check_path: "",
  compress: false,
  public_protocol: "off",
  public_port: "",
};

export function DeployPage() {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [extraEnv, setExtraEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<number | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [servicesOpen, setServicesOpen] = useState(false);

  useEffect(() => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  const [introspect, setIntrospect] = useState<IntrospectResult | null>(null);
  const [introspecting, setIntrospecting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const introspectSeq = useRef(0);
  // Manual override for which ocd-stack.json to resolve; blank = auto-detect.
  const [stackPath, setStackPath] = useState("");
  const [stackAdvancedOpen, setStackAdvancedOpen] = useState(false);
  const [stackDeploying, setStackDeploying] = useState(false);
  const canStack = useHasPermission("stacks.deploy");

  const [selectedManifest, setSelectedManifest] = useState<number | null>(null);
  const [manifestEnvDefs, setManifestEnvDefs] = useState<ManifestEnvDef[]>([]);

  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });

  function applyManifest(idx: number, result: AppIntrospect) {
    const pm = result.manifests[idx];
    if (!pm) return;
    const m = pm.manifest;

    setSelectedManifest(idx);
    setForm((f) => {
      // internal_protocol and health_check are independent (routing vs probe):
      // take each from the manifest's explicit value, else keep the form default.
      const internal_protocol = m.internal_protocol ?? f.internal_protocol;
      const health_check = m.health_check?.enabled ?? f.health_check;
      // Raw public exposure is expressed by public_protocol and/or public_port
      // (a bare public_port defaults to the tcp pool).
      const exposed = m.public_protocol != null || m.public_port != null;
      return {
        ...f,
        app_name: m.suggested_app_name || f.app_name || result.suggested_app_name,
        git_branch: f.git_branch || (result.default_branch !== "main" ? result.default_branch : ""),
        container_port: m.build?.container_port
          ? String(m.build.container_port)
          : result.detected_port
            ? String(result.detected_port)
            : f.container_port,
        dockerfile_path: m.build?.dockerfile || f.dockerfile_path,
        docker_context: m.build?.context || f.docker_context,
        volume_size: m.volume?.size ? String(m.volume.size) : f.volume_size,
        volume_path: m.volume?.path || f.volume_path,
        webhook_enabled: m.webhook?.enabled ?? f.webhook_enabled,
        webhook_branch: m.webhook?.branch || result.default_branch,
        webhook_path: m.webhook?.path || f.webhook_path,
        webhook_wait_for_ci: m.webhook?.wait_for_ci ?? f.webhook_wait_for_ci,
        replicas: m.replicas ? String(m.replicas) : f.replicas,
        public: m.public ?? f.public,
        extra_volumes: m.extra_volumes ?? f.extra_volumes,
        memory_mb: m.memory_mb ? String(m.memory_mb) : f.memory_mb,
        cpu_limit: m.cpu_limit ? String(m.cpu_limit) : f.cpu_limit,
        health_check,
        internal_protocol,
        sticky: m.sticky ?? f.sticky,
        rate_limit_rps: m.rate_limit_rps !== undefined ? String(m.rate_limit_rps) : f.rate_limit_rps,
        ip_allowlist: m.ip_allowlist ?? f.ip_allowlist,
        health_check_path: m.health_check?.path ?? f.health_check_path,
        compress: m.compress ?? f.compress,
        public_protocol: m.public_protocol ?? (exposed ? "tcp" : f.public_protocol),
        public_port: typeof m.public_port === "number"
          ? String(m.public_port)
          : m.public_port === "auto"
            ? ""
            : f.public_port,
      };
    });

    if (m.env && m.env.length > 0) {
      setManifestEnvDefs(m.env);
      setEnvValues(() => {
        const next: Record<string, string> = {};
        for (const e of m.env!) next[e.key] = e.default ?? "";
        return next;
      });
    } else {
      setManifestEnvDefs([]);
      if (result.env_vars.length > 0) {
        const next: Record<string, string> = {};
        for (const { key, value } of result.env_vars) next[key] = value;
        setEnvValues(next);
      } else {
        setEnvValues({});
      }
    }
  }

  function clearManifest(result: AppIntrospect) {
    setSelectedManifest(null);
    setManifestEnvDefs([]);
    setForm((f) => ({
      ...f,
      app_name: f.app_name || result.suggested_app_name,
      container_port: result.detected_port ? String(result.detected_port) : "3000",
      dockerfile_path: result.dockerfiles[0] ?? "",
      webhook_branch: result.default_branch,
      volume_size: "",
      volume_path: "/data",
      webhook_enabled: false,
      webhook_path: "",
      webhook_wait_for_ci: false,
      replicas: "1",
      memory_mb: "",
      cpu_limit: "",
      health_check: true,
      internal_protocol: "http",
      sticky: false,
      rate_limit_rps: "",
      ip_allowlist: "",
      health_check_path: "",
      compress: false,
      public_protocol: "off",
      public_port: "",
    }));
    if (result.env_vars.length > 0) {
      const next: Record<string, string> = {};
      for (const { key, value } of result.env_vars) next[key] = value;
      setEnvValues(next);
    } else {
      setEnvValues({});
    }
  }

  // --- Deploy session persistence ---
  const [pendingSession, setPendingSession] = useState<{
    form: FormState;
    envValues: Record<string, string>;
    extraEnv: Array<{ key: string; value: string }>;
    manifestEnvDefs?: ManifestEnvDef[];
    selectedEnvironmentId?: number | null;
  } | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  // When true, the introspect effect is suppressed so a restored session
  // isn't overwritten by repo discovery.
  const skipIntrospect = useRef(false);

  // Check for a saved deploy session on mount
  useEffect(() => {
    get("/api/deploy-session")
      .then((res: any) => {
        if (res.session) setPendingSession(res.session);
      })
      .catch(() => {});
  }, []);

  function restoreSession() {
    if (!pendingSession) return;
    // Suppress the introspect effect that would fire from setting git_repo
    skipIntrospect.current = true;
    setForm({ ...EMPTY_FORM, ...pendingSession.form });
    if (pendingSession.envValues) setEnvValues(pendingSession.envValues);
    if (pendingSession.extraEnv) setExtraEnv(pendingSession.extraEnv);
    if (pendingSession.manifestEnvDefs) setManifestEnvDefs(pendingSession.manifestEnvDefs);
    if (pendingSession.selectedEnvironmentId !== undefined) {
      setSelectedEnvironmentId(pendingSession.selectedEnvironmentId);
    }
    // Show the form sections immediately
    setRevealed(true);
    setPendingSession(null);
  }

  function dismissSession() {
    del("/api/deploy-session").catch(() => {});
    setPendingSession(null);
  }

  // Auto-save form state (debounced 1s) — skip initial render
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!form.app_name && !form.git_repo) return;
    setSaveStatus("saving");
    const timer = setTimeout(() => {
      post("/api/deploy-session", { form, envValues, extraEnv, manifestEnvDefs, selectedEnvironmentId })
        .then(() => {
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2000);
        })
        .catch(() => setSaveStatus("idle"));
    }, 1000);
    return () => clearTimeout(timer);
  }, [form, envValues, extraEnv, manifestEnvDefs, selectedEnvironmentId]);

  // --- Repo introspection ---
  const runIntrospect = useCallback(async (url: string, ref: string | undefined, path?: string) => {
    if (!/github\.com[/:][^/]+\/[^/]+/.test(url)) {
      setIntrospect(null);
      setIntrospecting(false);
      setRevealed(true);
      return;
    }
    const mySeq = ++introspectSeq.current;
    setIntrospecting(true);
    try {
      const qs = new URLSearchParams({ url });
      if (ref) qs.set("ref", ref);
      if (path) qs.set("path", path);
      const result: IntrospectResult = await get(`/api/repos/introspect?${qs.toString()}`);
      if (mySeq !== introspectSeq.current) return;
      setIntrospect(result);
      setRevealed(true);
      // Stack repos seed their editor via useStackForm; nothing to apply here.
      if (result.ok && result.kind === "app") {
        // Manifest set can differ between branches — reset selection on every fetch.
        setSelectedManifest(null);
        setManifestEnvDefs([]);
        if (result.manifests.length === 1) {
          applyManifest(0, result);
        } else if (result.manifests.length === 0) {
          setForm((f) => ({
            ...f,
            app_name: f.app_name || result.suggested_app_name,
            git_branch: ref || f.git_branch || (result.default_branch !== "main" ? result.default_branch : ""),
            container_port:
              f.container_port === "3000" && result.detected_port
                ? String(result.detected_port)
                : f.container_port,
            dockerfile_path: result.dockerfiles[0] ?? f.dockerfile_path,
            webhook_branch:
              f.webhook_branch === "main" ? result.default_branch : f.webhook_branch,
          }));
          if (result.env_vars.length > 0) {
            setEnvValues((prev) => {
              const next = { ...prev };
              for (const { key, value } of result.env_vars) {
                if (!(key in next)) next[key] = value;
              }
              return next;
            });
          }
        }
      } else if (!result.ok && result.suggested_app_name) {
        setForm((f) => ({ ...f, app_name: f.app_name || result.suggested_app_name! }));
      }
    } catch (err: any) {
      if (mySeq !== introspectSeq.current) return;
      setIntrospect({
        ok: false,
        error: err?.message || "We couldn't read that repo. Fill it in manually below.",
      });
      setRevealed(true);
    } finally {
      if (mySeq === introspectSeq.current) setIntrospecting(false);
    }
  }, []);

  // Debounced re-introspect whenever the repo URL changes.
  useEffect(() => {
    if (skipIntrospect.current) {
      skipIntrospect.current = false;
      return;
    }
    const url = form.git_repo.trim();
    if (!url) {
      setIntrospect(null);
      setRevealed(false);
      return;
    }
    const timer = setTimeout(() => {
      runIntrospect(url, undefined, stackPath.trim() || undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.git_repo, stackPath, runIntrospect]);

  // Fired when the user picks a branch (app receipt dropdown or stack branch
  // select) — re-run introspection on that ref so manifests / apps / env reflect it.
  const handleBranchChange = useCallback(
    (branch: string) => {
      setForm((f) => ({ ...f, git_branch: branch }));
      const url = form.git_repo.trim();
      if (url) runIntrospect(url, branch, stackPath.trim() || undefined);
    },
    [form.git_repo, stackPath, runIntrospect],
  );

  const set =
    (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({
        ...f,
        [k]:
          e.target.type === "checkbox"
            ? (e.target as HTMLInputElement).checked
            : e.target.value,
      }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Stack repos deploy via their own button (handleStackDeploy); ignore an
    // Enter-key form submit so it can't fall through to the app deploy path.
    if (introspect?.ok && introspect.kind === "stack") return;
    if (introspecting)
      return showToast("Hold on, still peeking at the repo", "info");
    if (!form.app_name || !form.git_repo)
      return showToast("App name and git repo are required", "error");

    // Unified env model: one app is a stack of one. The manifest/detected env
    // inputs are the app's defaults; the "add env var" rows are --set overrides.
    // Keys the reused environment already defines are dropped from `entries`
    // (existing wins), so we always send both env_vars and environment_id and
    // let the engine layer them.
    const existingKeys = new Set<string>(
      (selectedEnvironmentId
        ? environments.find((e) => e.id === selectedEnvironmentId)?.env_vars ?? []
        : []
      ).map((v) => v.key),
    );
    const defs = Object.keys(envValues).map((key) => {
      const d = manifestEnvDefs.find((m) => m.key === key);
      return {
        key,
        default: envValues[key],
        required: d?.required,
        secret: d?.secret,
        description: d?.description,
      };
    });
    const overrides: Record<string, string> = {};
    for (const v of extraEnv) if (v.key.trim()) overrides[v.key] = v.value;
    const merged = mergeEnv([{ app: form.app_name || "app", defs }], overrides, existingKeys);
    if (merged.requiredMissing.length > 0)
      return showToast(`Required: ${merged.requiredMissing.map((m) => m.key).join(", ")}`, "error");
    const envArray = merged.entries.length > 0 ? merged.entries : undefined;

    const body: DeployBody = {
      app_name: form.app_name,
      git_repo: form.git_repo,
      git_branch: form.git_branch || undefined,
      domain: form.domain || undefined,
      container_port: parseInt(form.container_port, 10),
      env_vars: envArray,
      environment_id: selectedEnvironmentId || undefined,
      volume_size: form.volume_size ? parseInt(form.volume_size, 10) : undefined,
      volume_path: form.volume_size ? form.volume_path : undefined,
      dockerfile_path: form.dockerfile_path || undefined,
      docker_context: form.docker_context || undefined,
      webhook_enabled: form.webhook_enabled,
      webhook_branch: form.webhook_enabled ? form.webhook_branch : undefined,
      webhook_path: form.webhook_enabled && form.webhook_path ? form.webhook_path : undefined,
      webhook_wait_for_ci: form.webhook_enabled ? form.webhook_wait_for_ci : undefined,
      auth_password: form.auth_password || undefined,
      replicas: parseInt(form.replicas, 10) || 1,
      public: form.public,
      extra_volumes: form.extra_volumes.length > 0
        ? form.extra_volumes.filter((v) => v.host_path && v.container_path)
        : undefined,
      server_id: form.server_id ? parseInt(form.server_id, 10) : undefined,
      memory_mb: form.memory_mb ? parseInt(form.memory_mb, 10) : undefined,
      cpu_limit: form.cpu_limit ? parseFloat(form.cpu_limit) : undefined,
      health_check: form.health_check === false ? false : undefined,
      internal_protocol: form.internal_protocol,
      sticky: form.sticky || undefined,
      rate_limit_rps: form.rate_limit_rps ? parseInt(form.rate_limit_rps, 10) : undefined,
      ip_allowlist: form.ip_allowlist.trim() || undefined,
      health_check_path: form.health_check_path.trim() || undefined,
      compress: form.compress || undefined,
      public_port: form.public_protocol === "off"
        ? undefined
        : (parseInt(form.public_port, 10) || "auto"),
      public_protocol: form.public_protocol === "off" ? undefined : form.public_protocol,
    };

    (async () => {
      try {
        const res = (await post("/api/apps/deploy", body)) as { op_id: number };
        if (!res.op_id) throw new Error("No op_id returned");
        window.location.hash = `#/deploy/progress/${res.op_id}`;
      } catch (err: any) {
        showToast(err?.message || "Failed to enqueue deploy", "error");
      }
    })();
  };

  // The introspect result is a discriminated union — split it into the app form
  // path and the stack path. Only one is ever non-null.
  const detected = introspect?.ok === true && introspect.kind === "app" ? introspect : null;
  const stack = introspect?.ok === true && introspect.kind === "stack" ? introspect : null;
  const stackPayload = stack?.stack ?? null;
  const stackBranch = form.git_branch || stack?.default_branch || "";

  // Hook is always called (stable order); it no-ops when stackPayload is null.
  const stackForm = useStackForm(stackPayload, stackBranch);

  const handleStackDeploy = () => {
    if (!stackPayload) return;
    if (stackForm.missingRequired.length > 0)
      return showToast(`Required: ${stackForm.missingRequired.join(", ")}`, "error");
    if (stackForm.conflicts.length > 0)
      return showToast(
        `Env conflict: ${stackForm.conflicts.map((c) => c.key).join(", ")}`,
        "error",
      );
    setStackDeploying(true);
    (async () => {
      try {
        const res = (await post("/api/stacks", stackForm.buildBody())) as { op_id?: number };
        if (!res?.op_id) throw new Error("No op_id returned");
        window.location.hash = `#/deploy/progress/${res.op_id}`;
      } catch (err: any) {
        showToast(err?.message || "Failed to enqueue stack deploy", "error");
        setStackDeploying(false);
      }
    })();
  };

  const showReceipt = revealed && (
    stack
      ? true
      : (selectedManifest !== null || !detected || detected.manifests.length <= 1)
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const requiredEnvMissing = useMemo(
    () => manifestEnvDefs.some((d) => d.required && !envValues[d.key]?.trim()),
    [manifestEnvDefs, envValues],
  );

  useEffect(() => {
    if (requiredEnvMissing && !selectedEnvironmentId) setAdvancedOpen(true);
  }, [requiredEnvMissing, selectedEnvironmentId]);

  const buildMode = "Dockerfile";
  const dockerfileLabel = form.dockerfile_path || (detected ? "auto-detect" : "");
  const branchLabel = form.git_branch || detected?.default_branch || "";
  const envCount = selectedEnvironmentId
    ? null
    : Object.keys(envValues).length + extraEnv.filter((e) => e.key.trim()).length;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        {stack ? <Boxes size={18} className="text-fg" /> : <Rocket size={18} className="text-fg" />}
        <h1 className="font-mono font-bold text-sm text-fg uppercase">{stack ? "Deploy Stack" : "Deploy"}</h1>
        {saveStatus === "saving" && !stack && (
          <Loader2 size={12} className="ml-auto animate-spin text-fg-dim" />
        )}
        {saveStatus === "saved" && !stack && (
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] text-fg-dim uppercase tracking-wider">
            <Save size={10} /> Saved
          </span>
        )}
      </div>
      <p className="text-fg-dim text-sm mb-5">
        {stack
          ? "We found a stack in this repo. Tweak any app or service, then deploy them together."
          : "Paste a repo. We detect the rest."}
      </p>

      {pendingSession && (
        <div className="mb-5 border-2 border-fg bg-bg-card px-4 py-3 flex items-center justify-between gap-3 animate-fade-in">
          <div className="flex items-center gap-2 min-w-0">
            <RotateCcw size={14} className="text-fg shrink-0" />
            <span className="font-mono text-[11px] text-fg truncate">
              Resume previous session{pendingSession.form.app_name ? ` for "${pendingSession.form.app_name}"` : ""}?
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Btn size="xs" variant="primary" onClick={restoreSession}>
              Restore
            </Btn>
            <button
              type="button"
              onClick={dismissSession}
              className="text-fg-dim hover:text-fg transition-colors"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className={showReceipt ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start" : ""}>
        <div className="border-2 border-fg bg-bg-raised shadow-neo divide-y-2 divide-fg">
          <RepoSection
            form={form}
            set={set}
            introspecting={introspecting}
            introspect={introspect}
          />

          {/* --- Stack mode: manifest/branch override + member editor --- */}
          {stack && stackPayload && (
            <StackAdvanced
              stackName={stackPayload.name}
              branch={form.git_branch || stack.default_branch}
              branches={stack.branches}
              onBranchChange={handleBranchChange}
              stackPath={stackPath}
              detectedPath={stackPayload.stack_path}
              onStackPathChange={setStackPath}
              open={stackAdvancedOpen}
              onToggle={() => setStackAdvancedOpen((o) => !o)}
            />
          )}
          {stack && stackPayload && <StackSection form={stackForm} />}
          {stack && stackPayload && stackPayload.notes.length > 0 && (
            <ul className="px-5 py-3 font-mono text-[9px] text-muted list-disc pl-9 space-y-0.5">
              {stackPayload.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          {/* --- App mode: manifest picker + receipt + advanced --- */}
          {!stack && revealed && detected && detected.manifests.length > 0 && (
            <ManifestSection
              detected={detected}
              selectedManifest={selectedManifest}
              onSelect={(idx) => applyManifest(idx, detected)}
              onClear={() => clearManifest(detected)}
            />
          )}

          {!stack && showReceipt && (
            <ReceiptSection
              form={form}
              set={set}
              setForm={setForm}
              detected={detected}
              onBranchChange={handleBranchChange}
            />
          )}

          {!stack && showReceipt && (
            <div>
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-alt transition-colors"
              >
                <span className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-fg">
                  <Settings2 size={12} /> Advanced
                </span>
                <span className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-muted">
                  env · memory · volumes · webhooks
                  <ChevronDown
                    size={12}
                    className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                  />
                </span>
              </button>
              {advancedOpen && (
                <div className="border-t-2 border-fg/15 px-5 pb-5 pt-4 space-y-6">
                  <EnvSection
                    envValues={envValues}
                    setEnvValues={setEnvValues}
                    manifestEnvDefs={manifestEnvDefs}
                    selectedEnvironmentId={selectedEnvironmentId}
                    onEnvironmentChange={setSelectedEnvironmentId}
                    environments={environments}
                  />
                  <AdvancedSection
                    form={form}
                    set={set}
                    setForm={setForm}
                    extraEnv={extraEnv}
                    setExtraEnv={setExtraEnv}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* --- Right column: shared "Ready to deploy" receipt --- */}
        {showReceipt && stack && stackPayload && (
          <div className="lg:sticky lg:top-6 border-2 border-fg bg-bg-raised shadow-neo">
            <div className="px-4 py-2.5 border-b-2 border-fg bg-accent flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg">
              <CheckCircle2 size={12} /> Ready to deploy
            </div>
            <div className="p-4 font-mono text-[11px] space-y-2.5">
              <SummaryRow label="Stack" value={stackPayload.name} />
              <SummaryRow
                label="Members"
                value={`${stackForm.specs.length} app(s) · ${stackForm.services.length} service(s)`}
              />
              <SummaryRow label="Branch" value={form.git_branch || stack.default_branch} />
            </div>
            {stackForm.conflicts.length > 0 && (
              <div className="border-t-2 border-fg/15 px-4 py-3 font-mono text-[10px] text-accent-red space-y-1">
                <div className="font-bold uppercase tracking-wider">Env conflict</div>
                {stackForm.conflicts.map((c) => (
                  <div key={c.key} className="text-fg-dim">
                    <span className="font-bold text-fg">{c.key}</span>: {c.values.join(" vs ")}
                  </div>
                ))}
                <div className="text-muted">Give these apps the same value to resolve.</div>
              </div>
            )}
            {canStack ? (
              <button
                type="button"
                onClick={handleStackDeploy}
                disabled={stackDeploying || stackForm.missingRequired.length > 0 || stackForm.conflicts.length > 0}
                title={
                  stackForm.missingRequired.length > 0
                    ? `Fill required: ${stackForm.missingRequired.join(", ")}`
                    : stackForm.conflicts.length > 0
                      ? `Resolve env conflicts: ${stackForm.conflicts.map((c) => c.key).join(", ")}`
                      : undefined
                }
                className="group w-full border-t-2 border-fg bg-accent hover:bg-accent-h active:bg-accent-h disabled:opacity-60 disabled:cursor-not-allowed py-4 flex items-center justify-center gap-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-fg transition-colors"
              >
                {stackDeploying
                  ? <Loader2 size={18} className="animate-spin" />
                  : <Boxes size={18} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />}
                Deploy stack
              </button>
            ) : (
              <div className="flex items-center gap-2 border-t-2 border-fg/15 px-4 py-4 font-mono text-[10px] text-muted">
                <Lock size={12} className="shrink-0" /> You don't have permission to deploy stacks.
              </div>
            )}
          </div>
        )}

        {showReceipt && !stack && (
          <div className="lg:sticky lg:top-6 border-2 border-fg bg-bg-raised shadow-neo">
            <div className="px-4 py-2.5 border-b-2 border-fg bg-accent flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg">
              <CheckCircle2 size={12} /> Ready to deploy
            </div>
            <div className="p-4 font-mono text-[11px] space-y-2.5">
              <SummaryRow label="App" value={form.app_name || "(set a name)"} />
              {branchLabel && <SummaryRow label="Branch" value={branchLabel} />}
              <SummaryRow label="Build" value={buildMode} />
              {dockerfileLabel && (
                <SummaryRow label="Dockerfile" value={dockerfileLabel} />
              )}
              <SummaryRow label="Port" value={form.container_port} />
              <SummaryRow label="Domain" value={form.domain || "auto (temporary)"} />
              {envCount === null ? (
                <SummaryRow label="Env" value="existing environment" />
              ) : envCount > 0 ? (
                <SummaryRow label="Env vars" value={String(envCount)} />
              ) : null}
            </div>
            <button
              type="submit"
              disabled={introspecting}
              className="group w-full border-t-2 border-fg bg-accent hover:bg-accent-h active:bg-accent-h disabled:opacity-60 disabled:cursor-not-allowed py-4 flex items-center justify-center gap-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-fg transition-colors"
            >
              <Rocket
                size={18}
                className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              />
              Deploy
            </button>
          </div>
        )}
        </div>
      </form>

      {!stack && (
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setServicesOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg underline transition-colors"
          >
            <Database size={11} />
            {servicesOpen ? "Hide services" : "Deploy a database or service instead"}
          </button>
        </div>
      )}

      {servicesOpen && (
        <div className="mt-4">
          <ServicesGridSection onClose={() => setServicesOpen(false)} />
        </div>
      )}
    </div>
  );
}
