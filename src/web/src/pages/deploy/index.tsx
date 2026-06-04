import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, showToast } from "../../components/ui.tsx";
import { Rocket, RotateCcw, X, Save, Loader2, Database, ChevronDown, Settings2, CheckCircle2 } from "lucide-react";
import { RepoSection } from "./repo-section.tsx";
import { ManifestSection } from "./manifest-section.tsx";
import { ReceiptSection } from "./receipt-section.tsx";
import { EnvSection } from "./env-section.tsx";
import { AdvancedSection } from "./advanced-section.tsx";
import type { IntrospectResult, ManifestEnvDef, FormState } from "./types.ts";
import type { DeployBody } from "../../types.ts";

type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
  icon?: string;
  color?: string;
  category?: string;
  http?: boolean;
  description?: string;
};

function groupByCategory(entries: CatalogEntry[]): [string, CatalogEntry[]][] {
  const buckets = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const key = e.category || "other";
    const list = buckets.get(key) || [];
    list.push(e);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return Array.from(buckets.entries()).sort(([a], [b]) => {
    if (a === "other") return 1;
    if (b === "other") return -1;
    return a.localeCompare(b);
  });
}

function ServicesGridSection({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    get("/api/services/catalog")
      .then((data: CatalogEntry[]) => {
        setCatalog(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  return (
    <div className="border-2 border-fg bg-bg animate-fade-in">
      <div className="px-4 py-2 border-b-2 border-fg bg-alt flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={12} className="text-fg" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-fg">Deploy a service</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-dim hover:text-fg transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="p-4">
        {!loaded ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-fg-dim" />
          </div>
        ) : catalog.length === 0 ? (
          <div className="font-mono text-[10px] text-fg-dim text-center py-6">No services available</div>
        ) : (
          <div className="space-y-5">
            {groupByCategory(catalog).map(([category, entries]) => (
              <div key={category}>
                <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim mb-2">
                  {category}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {entries.map((entry) => (
                    <a
                      key={entry.type}
                      href={`#/deploy-service/${entry.type}`}
                      className="flex items-start gap-2 border-2 border-fg/20 hover:border-fg bg-bg hover:bg-alt p-2.5 transition-colors"
                    >
                      <div className={`w-7 h-7 ${entry.color || "bg-gray-500"} flex items-center justify-center text-white font-mono text-[9px] font-bold shrink-0`}>
                        {entry.icon || entry.label.slice(0, 2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] font-bold text-fg uppercase truncate">{entry.label}</div>
                        {entry.description && (
                          <div className="font-mono text-[9px] text-fg-dim mt-0.5 line-clamp-2">{entry.description}</div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[9px] uppercase tracking-wider text-muted shrink-0">{label}</span>
      <span className="text-fg truncate text-right">{value}</span>
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
  compose_file: "",
  compose_web_service: "",
  public: true,
  extra_volumes: [],
  server_id: "",
  memory_mb: "",
};

export function DeployPage() {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [extraEnv, setExtraEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<number | null>(null);
  const [servicesOpen, setServicesOpen] = useState(false);

  const [introspect, setIntrospect] = useState<IntrospectResult | null>(null);
  const [introspecting, setIntrospecting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const introspectSeq = useRef(0);

  const [selectedManifest, setSelectedManifest] = useState<number | null>(null);
  const [manifestEnvDefs, setManifestEnvDefs] = useState<ManifestEnvDef[]>([]);

  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });

  function applyManifest(idx: number, result: IntrospectResult & { ok: true }) {
    const pm = result.manifests[idx];
    if (!pm) return;
    const m = pm.manifest;

    setSelectedManifest(idx);
    setForm((f) => ({
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
      compose_file: m.build?.compose_file || f.compose_file,
      compose_web_service: m.build?.compose_web_service || f.compose_web_service,
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
    }));

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

  function clearManifest(result: IntrospectResult & { ok: true }) {
    setSelectedManifest(null);
    setManifestEnvDefs([]);
    setForm((f) => ({
      ...f,
      app_name: f.app_name || result.suggested_app_name,
      container_port: result.detected_port ? String(result.detected_port) : "3000",
      dockerfile_path: result.dockerfiles[0] ?? "",
      compose_file: result.compose_files[0] ?? "",
      compose_web_service: result.suggested_web_service ?? "",
      webhook_branch: result.default_branch,
      volume_size: "",
      volume_path: "/data",
      webhook_enabled: false,
      webhook_path: "",
      webhook_wait_for_ci: false,
      replicas: "1",
      memory_mb: "",
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
  const runIntrospect = useCallback(async (url: string, ref: string | undefined) => {
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
      const result: IntrospectResult = await get(`/api/repos/introspect?${qs.toString()}`);
      if (mySeq !== introspectSeq.current) return;
      setIntrospect(result);
      setRevealed(true);
      if (result.ok) {
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
            compose_file: result.compose_files[0] ?? f.compose_file,
            compose_web_service: result.suggested_web_service ?? f.compose_web_service,
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
      } else if (result.suggested_app_name) {
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
      runIntrospect(url, undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.git_repo, runIntrospect]);

  // Fired when the user picks a branch from the receipt dropdown — re-run
  // introspection on that ref so manifests / Dockerfiles / env reflect it.
  const handleBranchChange = useCallback(
    (branch: string) => {
      setForm((f) => ({ ...f, git_branch: branch }));
      const url = form.git_repo.trim();
      if (url) runIntrospect(url, branch);
    },
    [form.git_repo, runIntrospect],
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
    if (introspecting)
      return showToast("Hold on — still peeking at the repo", "info");
    if (!form.app_name || !form.git_repo)
      return showToast("App name and git repo are required", "error");

    if (manifestEnvDefs.length > 0 && !selectedEnvironmentId) {
      const missing = manifestEnvDefs.filter((e) => e.required && !envValues[e.key]?.trim());
      if (missing.length > 0)
        return showToast(`Required: ${missing.map((e) => e.key).join(", ")}`, "error");
    }

    // If using an existing environment, don't send env_vars
    let envArray: Array<{ key: string; value: string; secret: boolean }> | undefined;
    if (!selectedEnvironmentId) {
      envArray = [];
      for (const [key, value] of Object.entries(envValues)) {
        const def = manifestEnvDefs.find((d) => d.key === key);
        envArray.push({ key, value, secret: def?.secret ?? false });
      }
      extraEnv.forEach((v) => {
        if (v.key) envArray!.push({ key: v.key, value: v.value, secret: false });
      });
    }

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
      compose_file: form.compose_file || undefined,
      compose_web_service: form.compose_web_service || undefined,
      public: form.public,
      extra_volumes: form.extra_volumes.length > 0
        ? form.extra_volumes.filter((v) => v.host_path && v.container_path)
        : undefined,
      server_id: form.server_id ? parseInt(form.server_id, 10) : undefined,
      memory_mb: form.memory_mb ? parseInt(form.memory_mb, 10) : undefined,
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

  const detected = introspect?.ok === true ? introspect : null;
  const showReceipt = revealed && (selectedManifest !== null || !detected || detected.manifests.length <= 1);

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const requiredEnvMissing = useMemo(
    () => manifestEnvDefs.some((d) => d.required && !envValues[d.key]?.trim()),
    [manifestEnvDefs, envValues],
  );

  useEffect(() => {
    if (requiredEnvMissing && !selectedEnvironmentId) setAdvancedOpen(true);
  }, [requiredEnvMissing, selectedEnvironmentId]);

  const buildMode = form.compose_file ? "Docker Compose" : "Dockerfile";
  const dockerfileLabel = form.compose_file || form.dockerfile_path || (detected ? "auto-detect" : "");
  const branchLabel = form.git_branch || detected?.default_branch || "";
  const envCount = selectedEnvironmentId
    ? null
    : Object.keys(envValues).length + extraEnv.filter((e) => e.key.trim()).length;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Rocket size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy</h1>
        {saveStatus === "saving" && (
          <Loader2 size={12} className="ml-auto animate-spin text-fg-dim" />
        )}
        {saveStatus === "saved" && (
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] text-fg-dim uppercase tracking-wider">
            <Save size={10} /> Saved
          </span>
        )}
      </div>
      <p className="text-fg-dim text-sm mb-7">Paste a repo. We detect the rest.</p>

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

          {revealed && detected && detected.manifests.length > 0 && (
            <ManifestSection
              detected={detected}
              selectedManifest={selectedManifest}
              onSelect={(idx) => applyManifest(idx, detected)}
              onClear={() => clearManifest(detected)}
            />
          )}

          {showReceipt && (
            <ReceiptSection
              form={form}
              set={set}
              setForm={setForm}
              detected={detected}
              selectedManifest={selectedManifest}
              onBranchChange={handleBranchChange}
            />
          )}

          {showReceipt && (
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

        {showReceipt && (
          <div className="lg:sticky lg:top-6 border-2 border-fg bg-bg-raised shadow-neo">
            <div className="px-4 py-2.5 border-b-2 border-fg bg-accent flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg">
              <CheckCircle2 size={12} /> Ready to deploy
            </div>
            <div className="p-4 font-mono text-[11px] space-y-2.5">
              <SummaryRow label="App" value={form.app_name || "(set a name)"} />
              {branchLabel && <SummaryRow label="Branch" value={branchLabel} />}
              <SummaryRow label="Build" value={buildMode} />
              {dockerfileLabel && (
                <SummaryRow label={form.compose_file ? "Compose" : "Dockerfile"} value={dockerfileLabel} />
              )}
              {!form.compose_file && <SummaryRow label="Port" value={form.container_port} />}
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

      {servicesOpen && (
        <div className="mt-4">
          <ServicesGridSection onClose={() => setServicesOpen(false)} />
        </div>
      )}
    </div>
  );
}
