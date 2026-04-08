import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, showToast, Checkbox } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Rocket, Plus, Minus, ChevronDown, ChevronRight } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { startDeploy } from "../stores/deploy-progress.ts";

type ServerOption = { id: number; name: string; ipv4: string; type: string; location: string };

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

export function DeployPage() {
  const { serverTypes } = useServerTypes();
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);

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

  useEffect(() => {
    if (serverTypes.length > 0 && !form.server_type) {
      const first = serverTypes[0];
      setForm((f) => ({ ...f, server_type: first.name, server_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.app_name || !form.git_repo) return showToast("App name and git repo are required", "error");

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

    // Kick off the deploy in the background store and navigate away from the
    // form so the user sees a focused progress view.
    void startDeploy(body);
    window.location.hash = "#/deploy/progress";
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 animate-fade-in">
      {/* Hero */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Rocket size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy New App</h1>
        </div>
        <p className="text-fg-dim text-[12px]">
          Point us at a Git repo. We handle the server, build, TLS and routing.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* The essentials — always visible */}
        <Card className="p-5 space-y-4">
          <div>
            <Label>App Name *</Label>
            <input type="text" value={form.app_name} onChange={set("app_name")} placeholder="my-app" required />
          </div>
          <div>
            <Label>Git Repository *</Label>
            <input type="text" value={form.git_repo} onChange={set("git_repo")} placeholder="https://github.com/user/repo" required />
          </div>
          <div>
            <Label>Domain</Label>
            <input type="text" value={form.domain} onChange={set("domain")} placeholder="app.example.com (optional)" />
          </div>
          <div>
            <Label>Server</Label>
            <NeoSelect
              value={form.server_id}
              onChange={(v) => setForm((f) => ({ ...f, server_id: v }))}
              placeholder="Create new server"
              options={[
                { value: "", label: "Create new server" },
                ...servers.map((s) => ({
                  value: String(s.id),
                  label: `${s.name} (${s.ipv4}) — ${s.type} @ ${s.location}`,
                })),
              ]}
            />
            {!form.server_id && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <Label>Type</Label>
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
                  <Label>Location</Label>
                  <NeoSelect
                    value={form.server_location}
                    onChange={(v) => setForm((f) => ({ ...f, server_location: v }))}
                    options={locationOptions(serverTypes, form.server_type)}
                  />
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Everything else — collapsed by default */}
        <Section title="Environment Variables">
          <div className="flex justify-end">
            <Btn
              size="xs"
              variant="ghost"
              onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
            >
              <Plus size={12} /> Add
            </Btn>
          </div>
          {envVars.length === 0 && (
            <div className="font-mono text-[10px] text-muted">No variables.</div>
          )}
          {envVars.map((v, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={v.key}
                placeholder="KEY"
                onChange={(e) => {
                  const next = [...envVars]; next[i].key = e.target.value; setEnvVars(next);
                }}
                className="!w-1/3"
              />
              <input
                type="text"
                value={v.value}
                placeholder="value"
                onChange={(e) => {
                  const next = [...envVars]; next[i].value = e.target.value; setEnvVars(next);
                }}
              />
              <button
                type="button"
                onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
              >
                <Minus size={14} />
              </button>
            </div>
          ))}
        </Section>

        <Section title="Build & Runtime">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Container Port</Label>
              <input type="number" value={form.container_port} onChange={set("container_port")} />
            </div>
            <div>
              <Label>Replicas</Label>
              <input type="number" value={form.replicas} onChange={set("replicas")} min="1" />
            </div>
          </div>
          <div>
            <Label>Dockerfile Path</Label>
            <input type="text" value={form.dockerfile_path} onChange={set("dockerfile_path")} placeholder="Auto-detect" />
          </div>
          <div>
            <Label>Auth Password</Label>
            <input type="password" value={form.auth_password} onChange={set("auth_password")} placeholder="Optional login gate" />
          </div>
        </Section>

        <Section title="Storage">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Volume Size (GB)</Label>
              <input type="number" value={form.volume_size} onChange={set("volume_size")} placeholder="0" min="0" />
            </div>
            <div>
              <Label>Volume Path</Label>
              <input type="text" value={form.volume_path} onChange={set("volume_path")} />
            </div>
          </div>
        </Section>

        <Section title="Webhook">
          <Checkbox
            checked={!!form.webhook_enabled}
            onChange={(v) => setForm((f: any) => ({ ...f, webhook_enabled: v }))}
            label="Auto-deploy on git push"
          />
          {form.webhook_enabled && (
            <div>
              <Label>Branch</Label>
              <input type="text" value={form.webhook_branch} onChange={set("webhook_branch")} />
            </div>
          )}
        </Section>

        <Section title="Docker Compose">
          <div>
            <Label>Compose File</Label>
            <input type="text" value={form.compose_file} onChange={set("compose_file")} placeholder="Auto-detect" />
          </div>
          <div>
            <Label>Web Service</Label>
            <input type="text" value={form.compose_web_service} onChange={set("compose_web_service")} placeholder="Auto-detect" />
          </div>
        </Section>

        <Btn type="submit" variant="primary" className="w-full !py-3 !text-[12px]">
          Deploy
        </Btn>
      </form>
    </div>
  );
}
