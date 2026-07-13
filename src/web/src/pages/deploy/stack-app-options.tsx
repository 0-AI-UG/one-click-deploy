import { Plus, X } from "lucide-react";
import type { StackAppSpec } from "../../types.ts";

// Full per-app deploy options for the stack builder — the same surface the
// single-app Deploy page exposes, pre-filled from the app's manifest. Every
// field maps 1:1 onto a DeployRequest field the deploy_stack op forwards.

type Patch = Partial<StackAppSpec>;

const inputCls =
  "bg-bg border-2 border-fg/40 px-2 py-1 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-fg";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="font-mono text-[10px] text-fg">{label}</div>
        {hint && <div className="font-mono text-[8px] text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[8px] text-muted uppercase tracking-wider mb-1 border-b border-fg/10 pb-1">{title}</div>
      {children}
    </div>
  );
}

function TextIn({ value, onChange, placeholder, width = "w-44", type = "text" }: {
  value: string | undefined; onChange: (v: string) => void; placeholder?: string; width?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} ${width}`}
    />
  );
}

function NumIn({ value, onChange, placeholder, width = "w-24" }: {
  value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string; width?: string;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      className={`${inputCls} ${width}`}
    />
  );
}

function Toggle({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={!!value}
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4 accent-accent cursor-pointer"
    />
  );
}

function Sel<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${inputCls} cursor-pointer`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function StackAppOptions({ spec, peers, onChange }: {
  spec: StackAppSpec;
  peers: string[]; // other app + service keys, for `needs`
  onChange: (patch: Patch) => void;
}) {
  const needs = spec.needs ?? [];
  const toggleNeed = (k: string) =>
    onChange({ needs: needs.includes(k) ? needs.filter((n) => n !== k) : [...needs, k] });

  const publicExposure: "off" | "tcp" | "udp" =
    spec.public_port === undefined || spec.public_port === null ? "off" : spec.public_protocol ?? "tcp";

  const extra = spec.extra_volumes ?? [];
  const setExtra = (i: number, patch: Partial<{ host_path: string; container_path: string }>) =>
    onChange({ extra_volumes: extra.map((v, idx) => (idx === i ? { ...v, ...patch } : v)) });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
      <Section title="Networking">
        <Row label="Domain" hint="blank = auto subdomain"><TextIn value={spec.domain} onChange={(v) => onChange({ domain: v || undefined })} placeholder="app.example.com" /></Row>
        <Row label="Public"><Toggle value={spec.public !== false} onChange={(v) => onChange({ public: v })} /></Row>
        <Row label="Internal protocol">
          <Sel value={spec.internal_protocol ?? "http"} onChange={(v) => onChange({ internal_protocol: v })}
            options={[{ value: "http", label: "http" }, { value: "tcp", label: "tcp" }]} />
        </Row>
        <Row label="Sticky sessions"><Toggle value={spec.sticky} onChange={(v) => onChange({ sticky: v || undefined })} /></Row>
        <Row label="Compress"><Toggle value={spec.compress} onChange={(v) => onChange({ compress: v || undefined })} /></Row>
        <Row label="Rate limit" hint="req/s, blank = off"><NumIn value={spec.rate_limit_rps} onChange={(v) => onChange({ rate_limit_rps: v })} /></Row>
        <Row label="IP allowlist" hint="comma-sep CIDRs"><TextIn value={spec.ip_allowlist} onChange={(v) => onChange({ ip_allowlist: v || undefined })} placeholder="1.2.3.0/24" /></Row>
      </Section>

      <Section title="Health & raw exposure">
        <Row label="HTTP health check"><Toggle value={spec.health_check !== false} onChange={(v) => onChange({ health_check: v ? undefined : false })} /></Row>
        <Row label="Health path" hint="e.g. /healthz"><TextIn value={spec.health_check_path} onChange={(v) => onChange({ health_check_path: v || undefined })} placeholder="/healthz" /></Row>
        <Row label="Raw exposure">
          <Sel value={publicExposure} onChange={(v) => onChange(
            v === "off" ? { public_port: undefined, public_protocol: undefined }
              : { public_port: spec.public_port && spec.public_port !== null ? spec.public_port : "auto", public_protocol: v },
          )} options={[{ value: "off", label: "off" }, { value: "tcp", label: "tcp" }, { value: "udp", label: "udp" }]} />
        </Row>
        {publicExposure !== "off" && (
          <Row label="Public port" hint="blank = auto">
            <TextIn width="w-24" value={spec.public_port === "auto" || spec.public_port == null ? "" : String(spec.public_port)}
              onChange={(v) => onChange({ public_port: v === "" ? "auto" : Number(v) })} placeholder="auto" />
          </Row>
        )}
        <Row label="Basic auth password" hint="blank = no auth"><TextIn type="password" value={spec.auth_password} onChange={(v) => onChange({ auth_password: v || undefined })} /></Row>
      </Section>

      <Section title="Build">
        <Row label="Container port"><NumIn value={spec.container_port} onChange={(v) => onChange({ container_port: v ?? 3000 })} /></Row>
        <Row label="Dockerfile" hint="repo-root relative"><TextIn value={spec.dockerfile_path} onChange={(v) => onChange({ dockerfile_path: v || undefined })} placeholder="auto-detect" /></Row>
        <Row label="Build context"><TextIn value={spec.docker_context} onChange={(v) => onChange({ docker_context: v || undefined })} placeholder="." /></Row>
      </Section>

      <Section title="Resources">
        <Row label="Replicas"><NumIn value={spec.replicas} onChange={(v) => onChange({ replicas: v })} placeholder="1" /></Row>
        <Row label="Memory (MB)" hint="0/blank = default"><NumIn value={spec.memory_mb} onChange={(v) => onChange({ memory_mb: v })} /></Row>
        <Row label="CPU (cores)" hint="fractional ok"><NumIn value={spec.cpu_limit} onChange={(v) => onChange({ cpu_limit: v })} /></Row>
      </Section>

      <Section title="Volume">
        <Row label="Size (GB)" hint="blank = none"><NumIn value={spec.volume_size} onChange={(v) => onChange({ volume_size: v, volume_path: v ? (spec.volume_path || "/data") : undefined })} /></Row>
        {spec.volume_size ? <Row label="Mount path"><TextIn value={spec.volume_path} onChange={(v) => onChange({ volume_path: v || "/data" })} placeholder="/data" /></Row> : null}
        <div className="mt-1">
          <div className="font-mono text-[9px] text-muted mb-1">Extra host mounts</div>
          {extra.map((v, i) => (
            <div key={i} className="flex items-center gap-1 mb-1">
              <TextIn width="w-24" value={v.host_path} onChange={(val) => setExtra(i, { host_path: val })} placeholder="host" />
              <span className="text-muted text-[10px]">:</span>
              <TextIn width="w-24" value={v.container_path} onChange={(val) => setExtra(i, { container_path: val })} placeholder="/in/container" />
              <button type="button" onClick={() => onChange({ extra_volumes: extra.filter((_, idx) => idx !== i) })} className="text-muted hover:text-accent-red"><X size={12} /></button>
            </div>
          ))}
          <button type="button" onClick={() => onChange({ extra_volumes: [...extra, { host_path: "", container_path: "" }] })}
            className="inline-flex items-center gap-1 font-mono text-[9px] text-fg-dim hover:text-fg"><Plus size={10} /> add mount</button>
        </div>
      </Section>

      <Section title="Webhook redeploy">
        <Row label="Enabled"><Toggle value={spec.webhook_enabled} onChange={(v) => onChange({ webhook_enabled: v || undefined })} /></Row>
        {spec.webhook_enabled && <>
          <Row label="Branch"><TextIn value={spec.webhook_branch} onChange={(v) => onChange({ webhook_branch: v || "main" })} placeholder="main" /></Row>
          <Row label="Path filter"><TextIn value={spec.webhook_path} onChange={(v) => onChange({ webhook_path: v || undefined })} placeholder="services/api" /></Row>
          <Row label="Wait for CI"><Toggle value={spec.webhook_wait_for_ci} onChange={(v) => onChange({ webhook_wait_for_ci: v || undefined })} /></Row>
        </>}
      </Section>

      {peers.length > 0 && (
        <Section title="Depends on (needs)">
          <div className="flex flex-wrap gap-1.5 pt-1">
            {peers.map((k) => {
              const on = needs.includes(k);
              return (
                <button key={k} type="button" onClick={() => toggleNeed(k)}
                  className={`font-mono text-[9px] px-2 py-1 border-2 ${on ? "border-fg bg-accent text-fg" : "border-fg/30 text-fg-dim hover:border-fg"}`}>
                  {k}
                </button>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}
