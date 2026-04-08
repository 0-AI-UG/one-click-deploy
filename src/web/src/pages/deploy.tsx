import { useState, useEffect, useRef } from "react";
import { get, post } from "../api/client.ts";
import { Card, Btn, Spinner, showToast, Checkbox } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Rocket, Plus, Minus, CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";

type ServerOption = { id: number; name: string; ipv4: string; type: string; location: string };

type ProgressEvent = { step: string; detail: string; ts: number };

const DEPLOY_STEPS: { key: string; label: string }[] = [
  { key: "server", label: "Server" },
  { key: "provision", label: "Provision" },
  { key: "dns", label: "DNS" },
  { key: "build", label: "Build" },
  { key: "caddy", label: "TLS / Proxy" },
  { key: "health", label: "Health" },
  { key: "done", label: "Done" },
];

function stepStatus(
  stepKey: string,
  events: ProgressEvent[],
  result: { ok: boolean; error?: string } | null,
): "pending" | "active" | "done" | "error" {
  const idx = DEPLOY_STEPS.findIndex((s) => s.key === stepKey);
  const seenKeys = new Set(events.map((e) => e.step));
  const hasError = events.some((e) => e.step === "error") || result?.ok === false;
  const lastIdx = Math.max(
    -1,
    ...events.map((e) => DEPLOY_STEPS.findIndex((s) => s.key === e.step)).filter((i) => i >= 0),
  );
  if (stepKey === "done") {
    return result?.ok ? "done" : hasError ? "error" : "pending";
  }
  if (!seenKeys.has(stepKey)) {
    if (hasError && idx === lastIdx + 1) return "error";
    return "pending";
  }
  if (idx < lastIdx) return "done";
  // idx === lastIdx
  if (hasError) return "error";
  if (result?.ok) return "done";
  return "active";
}

export function DeployPage() {
  const { serverTypes } = useServerTypes();
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  // Auto-scroll log to bottom when new events arrive
  useEffect(() => {
    progressRef.current?.scrollTo(0, progressRef.current.scrollHeight);
  }, [progress.length]);

  const [form, setForm] = useState({
    app_name: "", git_repo: "", domain: "", container_port: "3000",
    server_id: "", server_type: "", server_location: "",
    volume_size: "", volume_path: "/data", dockerfile_path: "",
    webhook_enabled: false, webhook_branch: "main",
    auth_password: "", replicas: "1",
    compose_file: "", compose_web_service: "",
  });

  useEffect(() => {
    get("/api/servers").then((data: any[]) => {
      setServers(data.map((s: any) => ({ id: s.id, name: s.name, ipv4: s.ipv4, type: s.type, location: s.location })));
    }).catch(() => {});
  }, []);

  // Auto-select first available type/location when server types load
  useEffect(() => {
    if (serverTypes.length > 0 && !form.server_type) {
      const first = serverTypes[0];
      setForm((f) => ({ ...f, server_type: first.name, server_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.app_name || !form.git_repo) return showToast("App name and git repo are required", "error");

    setDeploying(true);
    setProgress([]);
    setDeployResult(null);

    const env: Record<string, string> = {};
    envVars.forEach((v) => { if (v.key) env[v.key] = v.value; });

    const body: any = {
      app_name: form.app_name,
      git_repo: form.git_repo,
      domain: form.domain || undefined,
      container_port: parseInt(form.container_port, 10),
      env_vars: env,
      server_id: form.server_id ? parseInt(form.server_id, 10) : undefined,
      server_type: form.server_id ? undefined : form.server_type,
      server_location: form.server_id ? undefined : form.server_location,
      volume_size: form.volume_size ? parseInt(form.volume_size, 10) : undefined,
      volume_path: form.volume_size ? form.volume_path : undefined,
      dockerfile_path: form.dockerfile_path || undefined,
      webhook_enabled: form.webhook_enabled,
      webhook_branch: form.webhook_enabled ? form.webhook_branch : undefined,
      auth_password: form.auth_password || undefined,
      replicas: parseInt(form.replicas, 10) || 1,
      compose_file: form.compose_file || undefined,
      compose_web_service: form.compose_web_service || undefined,
    };

    // Open the SSE stream BEFORE posting so the server's progress listener is
    // registered in time to catch the very first emit. EventSource can't send
    // auth headers, so we use fetch + manual SSE parsing instead.
    const token = localStorage.getItem("ocd-auth");
    const authToken = token ? JSON.parse(token).token : "";
    const abort = new AbortController();
    streamAbortRef.current = abort;

    const streamUrl = `/api/apps/${encodeURIComponent(form.app_name)}/deploy/stream`;
    let streamReady: Promise<void>;
    try {
      const streamRes = await fetch(streamUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: abort.signal,
      });
      if (!streamRes.ok || !streamRes.body) {
        throw new Error(`stream failed (${streamRes.status})`);
      }

      // Consume the SSE body in the background
      streamReady = (async () => {
        const reader = streamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by double-newline
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              setProgress((p) => [...p, { step: data.step, detail: data.detail, ts: Date.now() }]);
            } catch {}
          }
        }
      })().catch(() => {}); // ignore aborts
    } catch (err) {
      // Stream setup failed — continue with the deploy anyway, no live updates
      streamReady = Promise.resolve();
    }

    try {
      const result = await post("/api/apps/deploy", body);
      setDeployResult(result);

      if (result.ok) {
        showToast("Deploy successful!", "success");
      } else {
        showToast(result.error || "Deploy failed", "error");
      }
    } catch (err: any) {
      setDeployResult({ ok: false, error: err.message });
      showToast(err.message, "error");
    } finally {
      abort.abort();
      streamAbortRef.current = null;
      setDeploying(false);
    }
  };

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-6">
        <Rocket size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy New App</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left column - Main config */}
          <div className="space-y-4">
            <Card className="p-4 space-y-3">
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Application</h3>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">App Name *</label>
                <input type="text" value={form.app_name} onChange={set("app_name")} placeholder="my-app" required />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Git Repository *</label>
                <input type="text" value={form.git_repo} onChange={set("git_repo")} placeholder="https://github.com/user/repo" required />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Domain</label>
                <input type="text" value={form.domain} onChange={set("domain")} placeholder="app.example.com" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Container Port</label>
                  <input type="number" value={form.container_port} onChange={set("container_port")} />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Replicas</label>
                  <input type="number" value={form.replicas} onChange={set("replicas")} min="1" />
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Server</h3>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Server</label>
                <NeoSelect
                  value={form.server_id}
                  onChange={(v) => setForm((f) => ({ ...f, server_id: v }))}
                  placeholder="Create new server"
                  options={[
                    { value: "", label: "Create new server" },
                    ...servers.map((s) => ({ value: String(s.id), label: `${s.name} (${s.ipv4}) — ${s.type} @ ${s.location}` })),
                  ]}
                />
              </div>
              {!form.server_id && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Type</label>
                    <NeoSelect
                      value={form.server_type}
                      onChange={(v) => {
                        setForm((f) => {
                          const locs = locationOptions(serverTypes, v);
                          const locValid = locs.some((l) => l.value === f.server_location);
                          return { ...f, server_type: v, ...(!locValid && locs.length ? { server_location: locs[0].value } : {}) };
                        });
                      }}
                      options={typeOptions(serverTypes)}
                    />
                  </div>
                  <div>
                    <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Location</label>
                    <NeoSelect
                      value={form.server_location}
                      onChange={(v) => setForm((f) => ({ ...f, server_location: v }))}
                      options={locationOptions(serverTypes, form.server_type)}
                    />
                  </div>
                </div>
              )}
            </Card>

            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Environment Variables</h3>
                <Btn size="xs" variant="ghost" onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}><Plus size={12} /> Add</Btn>
              </div>
              {envVars.map((v, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="text" value={v.key} placeholder="KEY" onChange={(e) => {
                    const next = [...envVars]; next[i].key = e.target.value; setEnvVars(next);
                  }} className="!w-1/3" />
                  <input type="text" value={v.value} placeholder="value" onChange={(e) => {
                    const next = [...envVars]; next[i].value = e.target.value; setEnvVars(next);
                  }} />
                  <button type="button" onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))} className="text-muted hover:text-accent-red transition-colors flex-shrink-0">
                    <Minus size={14} />
                  </button>
                </div>
              ))}
            </Card>
          </div>

          {/* Right column - Optional config */}
          <div className="space-y-4">
            <Card className="p-4 space-y-3">
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Optional</h3>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Dockerfile Path</label>
                <input type="text" value={form.dockerfile_path} onChange={set("dockerfile_path")} placeholder="Auto-detect" />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Auth Password</label>
                <input type="password" value={form.auth_password} onChange={set("auth_password")} placeholder="Optional login gate" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Volume Size (GB)</label>
                  <input type="number" value={form.volume_size} onChange={set("volume_size")} placeholder="0" min="0" />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Volume Path</label>
                  <input type="text" value={form.volume_path} onChange={set("volume_path")} />
                </div>
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Webhook</h3>
              <Checkbox checked={!!form.webhook_enabled} onChange={(v) => setForm((f: any) => ({ ...f, webhook_enabled: v }))} label="Auto-deploy on git push" />
              {form.webhook_enabled && (
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Branch</label>
                  <input type="text" value={form.webhook_branch} onChange={set("webhook_branch")} />
                </div>
              )}
            </Card>

            <Card className="p-4 space-y-3">
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Docker Compose</h3>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Compose File</label>
                <input type="text" value={form.compose_file} onChange={set("compose_file")} placeholder="Auto-detect" />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Web Service</label>
                <input type="text" value={form.compose_web_service} onChange={set("compose_web_service")} placeholder="Auto-detect" />
              </div>
            </Card>

            <Btn type="submit" variant="primary" className="w-full !py-2.5" disabled={deploying} loading={deploying}>
              {deploying ? "Deploying..." : "Deploy"}
            </Btn>
          </div>
        </div>
      </form>

      {/* Progress / Result */}
      {(deploying || deployResult) && (
        <Card className="mt-6 p-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Deploy Progress</h3>

          {/* Stepper */}
          <div className="flex flex-wrap items-center gap-x-1 gap-y-2 mb-3">
            {DEPLOY_STEPS.map((s, i) => {
              const status = stepStatus(s.key, progress, deployResult);
              const icon =
                status === "done" ? (
                  <CheckCircle2 size={12} className="text-accent-green" />
                ) : status === "active" ? (
                  <Loader2 size={12} className="animate-spin text-accent-amber" />
                ) : status === "error" ? (
                  <XCircle size={12} className="text-accent-red" />
                ) : (
                  <Circle size={12} className="text-muted" />
                );
              const textColor =
                status === "done"
                  ? "text-fg"
                  : status === "active"
                  ? "text-accent-amber"
                  : status === "error"
                  ? "text-accent-red"
                  : "text-muted";
              return (
                <div key={s.key} className="flex items-center">
                  <div className={`flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider font-bold ${textColor}`}>
                    {icon}
                    <span>{s.label}</span>
                  </div>
                  {i < DEPLOY_STEPS.length - 1 && (
                    <span className="mx-1 text-muted font-mono text-[9px]">›</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Live log */}
          <div
            ref={progressRef}
            className="bg-alt border-2 border-fg p-3 h-64 overflow-y-auto font-mono text-[10px] space-y-0.5"
          >
            {progress.length === 0 && deploying && !deployResult && (
              <div className="flex items-center gap-2 text-accent-amber">
                <Loader2 size={12} className="animate-spin" />
                <span>Waiting for first event...</span>
              </div>
            )}
            {progress.map((ev, i) => {
              const isError = ev.step === "error";
              return (
                <div key={i} className={`flex gap-2 ${isError ? "text-accent-red" : "text-fg"}`}>
                  <span className="text-muted shrink-0 w-16 uppercase">[{ev.step}]</span>
                  <span className="whitespace-pre-wrap break-all">{ev.detail}</span>
                </div>
              );
            })}
            {deployResult && (
              <div className={`flex items-center gap-2 mt-2 pt-2 border-t border-fg ${deployResult.ok ? "text-accent-green" : "text-accent-red"}`}>
                {deployResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span className="font-bold">
                  {deployResult.ok ? "Deploy completed successfully" : `Deploy failed: ${deployResult.error}`}
                </span>
              </div>
            )}
          </div>

          {deployResult?.ok && (
            <Btn variant="primary" className="mt-3" onClick={() => { window.location.hash = "#/"; }}>
              Go to Dashboard
            </Btn>
          )}
        </Card>
      )}
    </div>
  );
}
