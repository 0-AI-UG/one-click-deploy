import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, showToast, Checkbox } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import {
  Rocket,
  Plus,
  Minus,
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  AlertTriangle,
} from "lucide-react";
import { startDeploy } from "../stores/deploy-progress.ts";

type IntrospectResult =
  | {
      ok: true;
      owner: string;
      repo: string;
      default_branch: string;
      suggested_app_name: string;
      dockerfiles: string[];
      compose_file: string | null;
      compose_services: Array<{ name: string; port: number | null; has_ports: boolean }>;
      suggested_web_service: string | null;
      detected_port: number | null;
      env_vars: Array<{ key: string; value: string }>;
      notes: string[];
    }
  | { ok: false; error: string; suggested_app_name?: string };

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">
    {children}
  </label>
);

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-2 border-fg shadow-neo-sm bg-bg-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-alt transition-colors"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          {title}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-3 border-t-2 border-fg">{children}</div>}
    </div>
  );
}

// A row in the "deployment receipt" — mono label on the left, an input/select
// on the right, separated by a hard divider. All fields are pre-filled when
// possible so the happy path is "paste a URL → click DEPLOY".
function ReceiptRow({
  label,
  children,
  detected,
}: {
  label: string;
  children: React.ReactNode;
  detected?: boolean;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 items-start py-3 border-b-2 border-fg/15 last:border-b-0">
      <div className="pt-2.5 flex items-center gap-1.5">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">
          {label}
        </span>
        {detected && (
          <span title="Auto-detected" className="text-accent-green">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function DeployPage() {
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [extraEnv, setExtraEnv] = useState<Array<{ key: string; value: string }>>([]);

  // Introspection state
  const [introspect, setIntrospect] = useState<IntrospectResult | null>(null);
  const [introspecting, setIntrospecting] = useState(false);
  const [revealed, setRevealed] = useState(false); // shows the receipt
  const introspectSeq = useRef(0);

  const [form, setForm] = useState({
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

  // Debounced auto-introspect when the user pastes/types a URL that looks
  // like a GitHub repo. Each call increments a seq so out-of-order responses
  // never overwrite a fresher one.
  useEffect(() => {
    const url = form.git_repo.trim();
    if (!url) {
      setIntrospect(null);
      setRevealed(false);
      return;
    }
    // Non-GitHub URL: clear any stale introspect, but reveal the receipt so
    // the user can fill the rest in by hand.
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
          // Hydrate the form with detected values, but don't clobber anything
          // the user has already typed by hand.
          setForm((f) => ({
            ...f,
            app_name: f.app_name || result.suggested_app_name,
            container_port:
              f.container_port === "3000" && result.detected_port
                ? String(result.detected_port)
                : f.container_port,
            dockerfile_path: f.dockerfile_path || (result.dockerfiles[0] ?? ""),
            compose_file: f.compose_file || (result.compose_file ?? ""),
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
  const hasMultipleDockerfiles = !!detected && detected.dockerfiles.length > 1;
  const hasMultipleServices = !!detected && detected.compose_services.length > 1;
  const envKeys = Object.keys(envValues);

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 animate-fade-in">
      {/* Hero */}
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
        {/* The paste bar — the only thing the user needs to fill in */}
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-5">
          <Label>Git Repository</Label>
          <input
            type="text"
            value={form.git_repo}
            onChange={set("git_repo")}
            placeholder="https://github.com/user/repo"
            required
            autoFocus
            className="!text-[12px] !py-3"
          />

          {/* Status line under the paste bar */}
          <div className="mt-3 min-h-[18px] flex items-center gap-2 font-mono text-[10px]">
            {introspecting && (
              <>
                <Loader2 size={12} className="animate-spin text-fg" />
                <span className="text-fg-dim">Peeking at the repo…</span>
              </>
            )}
            {!introspecting && detected && (
              <>
                <Check size={12} strokeWidth={3} className="text-fg bg-accent border-2 border-fg" />
                <span className="text-fg">
                  Found {detected.dockerfiles.length > 0 ? "Dockerfile" : detected.compose_file ? "compose" : "repo"}
                  {detected.detected_port ? ` · port ${detected.detected_port}` : ""}
                  {detected.env_vars.length > 0
                    ? ` · ${detected.env_vars.length} env var${detected.env_vars.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </>
            )}
            {!introspecting && introspect && !introspect.ok && (
              <>
                <AlertTriangle size={12} className="text-accent-red" />
                <span className="text-fg-dim">{introspect.error}</span>
              </>
            )}
          </div>
        </div>

        {/* The receipt — appears once we've peeked (or once user starts typing
            something we couldn't peek at). Pre-filled, click DEPLOY. */}
        {revealed && (
          <Card className="p-5 animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
                Deployment Receipt
              </span>
              {detected && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  {detected.owner}/{detected.repo}
                </span>
              )}
            </div>

            <div className="border-t-2 border-fg pt-1">
              <ReceiptRow label="App Name" detected={!!detected}>
                <input type="text" value={form.app_name} onChange={set("app_name")} required />
              </ReceiptRow>

              {/* Build source: Dockerfile, or a picker if multiple */}
              <ReceiptRow
                label={detected?.compose_file ? "Compose" : "Dockerfile"}
                detected={!!detected && (detected.dockerfiles.length > 0 || !!detected.compose_file)}
              >
                {hasMultipleDockerfiles ? (
                  <NeoSelect
                    value={form.dockerfile_path}
                    onChange={(v) => setForm((f) => ({ ...f, dockerfile_path: v }))}
                    options={detected!.dockerfiles.map((d) => ({ value: d, label: d }))}
                  />
                ) : detected?.compose_file ? (
                  <input
                    type="text"
                    value={form.compose_file}
                    onChange={set("compose_file")}
                    placeholder={detected.compose_file}
                  />
                ) : (
                  <input
                    type="text"
                    value={form.dockerfile_path}
                    onChange={set("dockerfile_path")}
                    placeholder="Auto-detect at deploy time"
                  />
                )}
              </ReceiptRow>

              {/* Compose service picker, only if multiple services */}
              {hasMultipleServices && (
                <ReceiptRow label="Web Service" detected>
                  <NeoSelect
                    value={form.compose_web_service}
                    onChange={(v) => setForm((f) => ({ ...f, compose_web_service: v }))}
                    options={detected!.compose_services.map((s) => ({
                      value: s.name,
                      label: s.has_ports ? `${s.name}  ·  exposes port` : s.name,
                    }))}
                  />
                </ReceiptRow>
              )}

              <ReceiptRow label="Listens On" detected={!!detected?.detected_port}>
                <input type="number" value={form.container_port} onChange={set("container_port")} />
              </ReceiptRow>

              <ReceiptRow label="Domain">
                <input
                  type="text"
                  value={form.domain}
                  onChange={set("domain")}
                  placeholder="app.example.com (we'll give you a temporary one if blank)"
                />
              </ReceiptRow>
            </div>

            {/* Notes from introspect */}
            {detected && detected.notes.length > 0 && (
              <div className="mt-3 pt-3 border-t-2 border-fg/15 space-y-1">
                {detected.notes.map((n, i) => (
                  <div key={i} className="font-mono text-[10px] text-fg-dim flex items-start gap-2">
                    <AlertTriangle size={11} className="text-accent-amber mt-0.5 flex-shrink-0" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Secrets card — only if we found env keys */}
        {revealed && envKeys.length > 0 && (
          <Card className="p-5 animate-fade-in">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
                Secrets
              </span>
              <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                Detected from .env.example
              </span>
            </div>
            <div className="space-y-2">
              {envKeys.map((key) => (
                <div key={key} className="grid grid-cols-[40%_1fr] gap-2 items-center">
                  <div className="font-mono text-[10px] font-bold text-fg truncate" title={key}>
                    {key}
                  </div>
                  <input
                    type="text"
                    value={envValues[key]}
                    placeholder="value"
                    onChange={(e) =>
                      setEnvValues((p) => ({ ...p, [key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Advanced — everything else, collapsed by default */}
        {revealed && (
          <Section title="Advanced">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Replicas</Label>
                <input
                  type="number"
                  value={form.replicas}
                  onChange={set("replicas")}
                  min="1"
                />
              </div>
              <div>
                <Label>Auth Password</Label>
                <input
                  type="password"
                  value={form.auth_password}
                  onChange={set("auth_password")}
                  placeholder="Optional login gate"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Volume Size (GB)</Label>
                <input
                  type="number"
                  value={form.volume_size}
                  onChange={set("volume_size")}
                  placeholder="0"
                  min="0"
                />
              </div>
              <div>
                <Label>Volume Path</Label>
                <input
                  type="text"
                  value={form.volume_path}
                  onChange={set("volume_path")}
                />
              </div>
            </div>
            <div>
              <Checkbox
                checked={!!form.webhook_enabled}
                onChange={(v) => setForm((f: any) => ({ ...f, webhook_enabled: v }))}
                label="Auto-deploy on git push"
              />
              {form.webhook_enabled && (
                <>
                <div className="mt-2">
                  <Label>Branch</Label>
                  <input
                    type="text"
                    value={form.webhook_branch}
                    onChange={set("webhook_branch")}
                  />
                </div>
                <div className="mt-2">
                  <Label>Path filter (optional)</Label>
                  <input
                    type="text"
                    value={form.webhook_path}
                    onChange={set("webhook_path")}
                    placeholder="e.g. services/api — only redeploy when files under this path change"
                  />
                </div>
                </>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Extra Environment Variables</Label>
                <Btn
                  size="xs"
                  variant="ghost"
                  onClick={() => setExtraEnv([...extraEnv, { key: "", value: "" }])}
                >
                  <Plus size={12} /> Add
                </Btn>
              </div>
              {extraEnv.map((v, i) => (
                <div key={i} className="flex gap-2 items-center mt-2">
                  <input
                    type="text"
                    value={v.key}
                    placeholder="KEY"
                    onChange={(e) => {
                      const next = [...extraEnv];
                      next[i].key = e.target.value;
                      setExtraEnv(next);
                    }}
                    className="!w-1/3"
                  />
                  <input
                    type="text"
                    value={v.value}
                    placeholder="value"
                    onChange={(e) => {
                      const next = [...extraEnv];
                      next[i].value = e.target.value;
                      setExtraEnv(next);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setExtraEnv(extraEnv.filter((_, j) => j !== i))}
                    className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
                  >
                    <Minus size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Section>
        )}

        {revealed && (
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
