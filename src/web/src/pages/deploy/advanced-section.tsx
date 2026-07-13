import { Plus, Minus, AlertTriangle } from "lucide-react";
import { Btn, Checkbox, Field, Divider } from "../../components/ui.tsx";
import { Label } from "./shared.tsx";
import { InfoTip } from "../app-detail/shared.tsx";
import type { FormState } from "./types.ts";

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  extraEnv: Array<{ key: string; value: string }>;
  setExtraEnv: React.Dispatch<React.SetStateAction<Array<{ key: string; value: string }>>>;
};

export function AdvancedSection({ form, set, setForm, extraEnv, setExtraEnv }: Props) {
  return (
    <div className="space-y-3">
      <Field label="Replicas">
        <input
          type="number"
          value={form.replicas}
          onChange={set("replicas")}
          min="1"
        />
        <p className="text-[9px] text-muted mt-1">The panel load-balances across replicas over the private network — a custom domain is not required.</p>
      </Field>
      <Field label="Auth Password">
        <input
          type="password"
          value={form.auth_password}
          onChange={set("auth_password")}
          placeholder="Optional login gate"
        />
        {form.auth_password && <p className="text-[9px] text-muted mt-1">HTTP basic auth — visitors sign in with username "admin" and this password</p>}
      </Field>
      <Field label="Volume Size (GB)">
        <input
          type="number"
          value={form.volume_size}
          onChange={set("volume_size")}
          placeholder="0"
          min="0"
        />
      </Field>
      <Field label="Volume Path">
        <input
          type="text"
          value={form.volume_path}
          onChange={set("volume_path")}
        />
      </Field>
      <Field label={<>Memory Limit (MB) <InfoTip text="Container memory ceiling. Blank or 0 uses the platform default (512)." /></>}>
        <input
          type="number"
          value={form.memory_mb}
          onChange={set("memory_mb")}
          placeholder="512 (platform default)"
          min="0"
        />
      </Field>
      <div>
        <Checkbox
          checked={form.public}
          onChange={(v) => setForm((f) => ({ ...f, public: v }))}
          label="Public access (expose via public domain)"
        />
        {!form.public && <p className="text-[9px] text-muted mt-1">App will only be reachable over the internal network</p>}
      </div>
      <Field label={<>Internal Protocol <InfoTip text="How Traefik routes internal traffic on <app>.ocd.internal. HTTP = L7 routing (required for password protection and an active health-check path). TCP = raw pass-through for non-HTTP protocols (databases, game servers)." /></>}>
        <select
          value={form.internal_protocol}
          onChange={set("internal_protocol")}
        >
          <option value="http">HTTP (L7 routing)</option>
          <option value="tcp">TCP (raw pass-through)</option>
        </select>
      </Field>
      <div>
        <Checkbox
          checked={form.health_check}
          onChange={(v) => setForm((f) => ({ ...f, health_check: v }))}
          label="HTTP health check after deploy"
        />
        <p className="text-[9px] text-muted mt-1">Probe <span className="font-mono">/</span> on the exposed port after each deploy/scale. Turn off for apps that don't answer HTTP there; the platform then only checks the container is running.</p>
      </div>
      <Field label={<>Rate Limit <InfoTip text="Requests per second allowed on the public domain. 0 or blank = unlimited. Internal traffic is never limited." /></>}>
        <input
          type="number"
          value={form.rate_limit_rps}
          onChange={set("rate_limit_rps")}
          placeholder="requests/sec, 0 = unlimited"
          min="0"
        />
      </Field>
      <Field label={<>IP Allowlist <InfoTip text="Only these IPs/CIDRs can reach the public domain. Blank = open to all." /></>}>
        <input
          type="text"
          value={form.ip_allowlist}
          onChange={set("ip_allowlist")}
          placeholder="comma-separated IPs or CIDRs"
        />
      </Field>
      <Field label={<>Health Check Path <InfoTip text="Active HTTP health check — replicas failing this path leave the load balancer rotation." /></>}>
        <input
          type="text"
          value={form.health_check_path}
          onChange={set("health_check_path")}
          placeholder="/healthz"
        />
      </Field>
      <div>
        <Checkbox
          checked={form.sticky}
          onChange={(v) => setForm((f) => ({ ...f, sticky: v }))}
          label="Sticky sessions (pin visitors to one replica)"
        />
      </div>
      <div>
        <Checkbox
          checked={form.compress}
          onChange={(v) => setForm((f) => ({ ...f, compress: v }))}
          label="Compress responses on the public domain"
        />
      </div>
      <Field label={<>Public TCP/UDP Port <InfoTip text="Forwards a dedicated public port on the panel IP raw to the app — for game servers, databases, MQTT. Independent of the public domain. Blank port = auto-assign (TCP 30000-30049, UDP 30050-30099)." /></>}>
        <div className="flex gap-2">
          <select value={form.public_protocol} onChange={set("public_protocol")}>
            <option value="off">Off</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
          {form.public_protocol !== "off" && (
            <input
              type="number"
              value={form.public_port}
              onChange={set("public_port")}
              placeholder="auto"
            />
          )}
        </div>
      </Field>
      <div>
        <Checkbox
          checked={!!form.webhook_enabled}
          onChange={(v) => setForm((f) => ({ ...f, webhook_enabled: v }))}
          label="Auto-deploy on git push"
        />
        {form.webhook_enabled && (
          <>
            <Field label="Branch">
              <input
                type="text"
                value={form.webhook_branch}
                onChange={set("webhook_branch")}
              />
            </Field>
            <Field label="Path filter (optional)">
              <input
                type="text"
                value={form.webhook_path}
                onChange={set("webhook_path")}
                placeholder="e.g. services/api — only redeploy when files under this path change"
              />
            </Field>
            <div className="mt-2">
              <Checkbox
                checked={!!form.webhook_wait_for_ci}
                onChange={(v) => setForm((f) => ({ ...f, webhook_wait_for_ci: v }))}
                label="Wait for CI checks to pass before deploying"
              />
            </div>
          </>
        )}
      </div>
      <Divider />
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label>Extra Volume Mounts</Label>
          <Btn
            size="xs"
            variant="ghost"
            onClick={() =>
              setForm((f) => ({
                ...f,
                extra_volumes: [...f.extra_volumes, { host_path: "", container_path: "" }],
              }))
            }
          >
            <Plus size={12} /> Add
          </Btn>
        </div>
        {form.extra_volumes.length > 0 && (
          <div className="flex items-start gap-1.5 mb-2 px-2 py-1.5 border border-accent-yellow/30 bg-accent-yellow/5 text-[9px] text-accent-yellow font-mono">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>Volume mounts give the container access to host paths. Only mount paths you trust.</span>
          </div>
        )}
        {form.extra_volumes.map((v, i) => (
          <div key={i} className="flex gap-2 items-center mt-2">
            <input
              type="text"
              value={v.host_path}
              placeholder="Host path"
              onChange={(e) =>
                setForm((f) => {
                  const next = [...f.extra_volumes];
                  next[i] = { ...next[i], host_path: e.target.value };
                  return { ...f, extra_volumes: next };
                })
              }
              className="!w-1/2"
            />
            <input
              type="text"
              value={v.container_path}
              placeholder="Container path"
              onChange={(e) =>
                setForm((f) => {
                  const next = [...f.extra_volumes];
                  next[i] = { ...next[i], container_path: e.target.value };
                  return { ...f, extra_volumes: next };
                })
              }
              className="!w-1/2"
            />
            <button
              type="button"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  extra_volumes: f.extra_volumes.filter((_, j) => j !== i),
                }))
              }
              className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
            >
              <Minus size={14} />
            </button>
          </div>
        ))}
      </div>
      <Divider />
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
    </div>
  );
}
