import { useState, useEffect, useRef } from "react";
import { get } from "../../api/client.ts";
import { Btn, showToast } from "../../components/ui.tsx";
import { Rocket } from "lucide-react";
import { startDeploy } from "../../stores/deploy-progress.ts";
import { RepoSection } from "./repo-section.tsx";
import { ManifestSection } from "./manifest-section.tsx";
import { ReceiptSection } from "./receipt-section.tsx";
import { EnvSection } from "./env-section.tsx";
import { AdvancedSection } from "./advanced-section.tsx";
import type { IntrospectResult, ManifestEnvDef, FormState } from "./types.ts";

export function DeployPage() {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [extraEnv, setExtraEnv] = useState<Array<{ key: string; value: string }>>([]);

  const [introspect, setIntrospect] = useState<IntrospectResult | null>(null);
  const [introspecting, setIntrospecting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const introspectSeq = useRef(0);

  const [selectedManifest, setSelectedManifest] = useState<number | null>(null);
  const [manifestEnvDefs, setManifestEnvDefs] = useState<ManifestEnvDef[]>([]);

  const [form, setForm] = useState<FormState>({
    app_name: "",
    git_repo: "",
    domain: "",
    container_port: "3000",
    volume_size: "",
    volume_path: "/data",
    dockerfile_path: "",
    webhook_enabled: false,
    webhook_branch: "main",
    webhook_path: "",
    auth_password: "",
    replicas: "1",
    compose_file: "",
    compose_web_service: "",
  });

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
      compose_file: m.build?.compose_file || f.compose_file,
      compose_web_service: m.build?.compose_web_service || f.compose_web_service,
      volume_size: m.volume?.size ? String(m.volume.size) : f.volume_size,
      volume_path: m.volume?.path || f.volume_path,
      webhook_enabled: m.webhook?.enabled ?? f.webhook_enabled,
      webhook_branch: m.webhook?.branch || result.default_branch,
      webhook_path: m.webhook?.path || f.webhook_path,
      replicas: m.replicas ? String(m.replicas) : f.replicas,
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

  useEffect(() => {
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

    if (manifestEnvDefs.length > 0) {
      const missing = manifestEnvDefs.filter((e) => e.required && !envValues[e.key]?.trim());
      if (missing.length > 0)
        return showToast(`Required: ${missing.map((e) => e.key).join(", ")}`, "error");
    }

    const env: Record<string, string> = { ...envValues };
    extraEnv.forEach((v) => {
      if (v.key) env[v.key] = v.value;
    });

    const body: any = {
      app_name: form.app_name,
      git_repo: form.git_repo,
      domain: form.domain || undefined,
      container_port: parseInt(form.container_port, 10),
      env_vars: env,
      volume_size: form.volume_size ? parseInt(form.volume_size, 10) : undefined,
      volume_path: form.volume_size ? form.volume_path : undefined,
      dockerfile_path: form.dockerfile_path || undefined,
      webhook_enabled: form.webhook_enabled,
      webhook_branch: form.webhook_enabled ? form.webhook_branch : undefined,
      webhook_path: form.webhook_enabled && form.webhook_path ? form.webhook_path : undefined,
      auth_password: form.auth_password || undefined,
      replicas: parseInt(form.replicas, 10) || 1,
      compose_file: form.compose_file || undefined,
      compose_web_service: form.compose_web_service || undefined,
    };

    void startDeploy(body);
    window.location.hash = "#/deploy/progress";
  };

  const detected = introspect?.ok === true ? introspect : null;
  const showReceipt = revealed && (selectedManifest !== null || !detected || detected.manifests.length <= 1);

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 animate-fade-in">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Rocket size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy New App</h1>
        </div>
        <p className="text-fg-dim text-[12px]">
          Paste a GitHub repo. We'll figure out the rest.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
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
          />
        )}

        {showReceipt && (
          <EnvSection
            envValues={envValues}
            setEnvValues={setEnvValues}
            manifestEnvDefs={manifestEnvDefs}
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
