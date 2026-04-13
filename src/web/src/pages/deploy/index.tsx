import { useState, useEffect, useRef, useCallback } from "react";
import { get, post, del } from "../../api/client.ts";
import { Btn, showToast } from "../../components/ui.tsx";
import { Rocket, RotateCcw, X, Save, Loader2, Database } from "lucide-react";
import { startDeploy } from "../../stores/deploy-progress.ts";
import { RepoSection } from "./repo-section.tsx";
import { ManifestSection } from "./manifest-section.tsx";
import { ReceiptSection } from "./receipt-section.tsx";
import { EnvSection } from "./env-section.tsx";
import { AdvancedSection } from "./advanced-section.tsx";
import type { IntrospectResult, ManifestEnvDef, FormState } from "./types.ts";
import type { DeployBody } from "../../types.ts";

const SERVICE_ICONS: Record<string, string> = {
  postgresql: "PG",
  mysql: "My",
  mariadb: "Ma",
  redis: "Re",
  mongodb: "Mo",
};

const SERVICE_COLORS: Record<string, string> = {
  postgresql: "bg-blue-600",
  mysql: "bg-orange-500",
  mariadb: "bg-teal-600",
  redis: "bg-red-500",
  mongodb: "bg-green-600",
};

type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
};

function ServicePopover() {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleEnter = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
    if (!loaded) {
      get("/api/services/catalog")
        .then((data: CatalogEntry[]) => {
          setCatalog(data);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  };

  const handleLeave = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 font-mono text-[10px] text-fg-dim hover:text-fg uppercase tracking-wider transition-colors"
      >
        <Database size={12} />
        Deploy a service
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 border-2 border-fg bg-bg shadow-lg min-w-[200px] animate-fade-in">
          {!loaded ? (
            <div className="px-3 py-2 flex items-center justify-center">
              <Loader2 size={14} className="animate-spin text-fg-dim" />
            </div>
          ) : catalog.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[10px] text-fg-dim">No services available</div>
          ) : (
            catalog.map((entry) => (
              <a
                key={entry.type}
                href={`#/deploy-service/${entry.type}`}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-alt transition-colors"
              >
                <div className={`w-5 h-5 ${SERVICE_COLORS[entry.type] || "bg-gray-500"} flex items-center justify-center text-white font-mono text-[7px] font-bold shrink-0`}>
                  {SERVICE_ICONS[entry.type] || "??"}
                </div>
                <span className="font-mono text-[10px] font-bold text-fg uppercase">{entry.label}</span>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM: FormState = {
  app_name: "",
  git_repo: "",
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
};

export function DeployPage() {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [extraEnv, setExtraEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<number | null>(null);

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
      post("/api/deploy-session", { form, envValues, extraEnv, manifestEnvDefs })
        .then(() => {
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2000);
        })
        .catch(() => setSaveStatus("idle"));
    }, 1000);
    return () => clearTimeout(timer);
  }, [form, envValues, extraEnv, manifestEnvDefs]);

  // --- Repo introspection ---
  useEffect(() => {
    // After a session restore, skip the first introspect trigger
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
    if (!/github\.com[/:][^/]+\/[^/]+/.test(url)) {
      setIntrospect(null);
      setIntrospecting(false);
      setRevealed(true);
      return;
    }

    const mySeq = ++introspectSeq.current;
    const timer = setTimeout(async () => {
      setIntrospecting(true);
      try {
        const result: IntrospectResult = await get(
          `/api/repos/introspect?url=${encodeURIComponent(url)}`,
        );
        if (mySeq !== introspectSeq.current) return;
        setIntrospect(result);
        setRevealed(true);
        if (result.ok) {
          if (result.manifests.length === 1) {
            applyManifest(0, result);
          } else if (result.manifests.length === 0) {
            setSelectedManifest(null);
            setManifestEnvDefs([]);
            setForm((f) => ({
              ...f,
              app_name: f.app_name || result.suggested_app_name,
              container_port:
                f.container_port === "3000" && result.detected_port
                  ? String(result.detected_port)
                  : f.container_port,
              dockerfile_path: f.dockerfile_path || (result.dockerfiles[0] ?? ""),
              compose_file: f.compose_file || (result.compose_files[0] ?? ""),
              compose_web_service:
                f.compose_web_service || (result.suggested_web_service ?? ""),
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
    }, 500);

    return () => clearTimeout(timer);
  }, [form.git_repo]);

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
    };

    void startDeploy(body);
    window.location.hash = "#/deploy/progress";
  };

  const detected = introspect?.ok === true ? introspect : null;
  const showReceipt = revealed && (selectedManifest !== null || !detected || detected.manifests.length <= 1);

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Rocket size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy New App</h1>
          {saveStatus === "saving" && (
            <Loader2 size={12} className="ml-auto animate-spin text-fg-dim" />
          )}
          {saveStatus === "saved" && (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] text-fg-dim uppercase tracking-wider">
              <Save size={10} /> Saved
            </span>
          )}
        </div>
      </div>

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

      <form onSubmit={handleSubmit} className="space-y-5">
        <RepoSection
          form={form}
          set={set}
          introspecting={introspecting}
          introspect={introspect}
          extra={<ServicePopover />}
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
          />
        )}

        {showReceipt && (
          <EnvSection
            envValues={envValues}
            setEnvValues={setEnvValues}
            manifestEnvDefs={manifestEnvDefs}
            selectedEnvironmentId={selectedEnvironmentId}
            onEnvironmentChange={setSelectedEnvironmentId}
          />
        )}

        {showReceipt && (
          <AdvancedSection
            form={form}
            set={set}
            setForm={setForm}
            extraEnv={extraEnv}
            setExtraEnv={setExtraEnv}
          />
        )}

        {showReceipt && (
          <Btn
            type="submit"
            variant="primary"
            disabled={introspecting}
            className="w-full !py-4 !text-[13px] animate-fade-in"
          >
            <Rocket size={14} /> Deploy
          </Btn>
        )}
      </form>
    </div>
  );
}
