import { Plus, Minus, AlertTriangle } from "lucide-react";
import { Btn, Checkbox, Field, Divider } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { Label } from "./shared.tsx";
import { HealthCheckField, InfoTip } from "../app-detail/shared.tsx";
import type { FormState } from "./types.ts";
import type { EnvironmentData } from "../../types.ts";

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  extraEnv: Array<{ key: string; value: string }>;
  setExtraEnv: React.Dispatch<React.SetStateAction<Array<{ key: string; value: string }>>>;
  environments: EnvironmentData[];
};

const PUBLIC_PORT_RANGES = { tcp: "30000–30049", udp: "30050–30099" } as const;

export function AdvancedSection({ form, set, setForm, extraEnv, setExtraEnv, environments }: Props) {
  // Password, an active health-check path and cookie sticky sessions are
  // HTTP/L7 concepts; raw-TCP internal routing can't carry them, so they only
  // render when the internal protocol is HTTP (mirrors the app settings tab and
  // the server's validateIngressFields rules).
  const httpRouted = form.internal_protocol === "http";
  return (
    <div className="space-y-3">
      <Field label={<>Replicas <InfoTip text="Run this many copies behind a load balancer." /></>}>
        <input
          type="number"
          value={form.replicas}
          onChange={set("replicas")}
          min="1"
        />
      </Field>
      <Field label={<>Volume Size (GB) <InfoTip text="Persistent disk mounted at the volume path. Blank/0 = none." /></>}>
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
      <Field label={<>Memory Limit (MB) <InfoTip text="Container memory cap. Blank/0 = default (512 MB)." /></>}>
        <input
          type="number"
          value={form.memory_mb}
          onChange={set("memory_mb")}
          placeholder="512 (platform default)"
          min="0"
        />
      </Field>
      <Field label={<>CPU Limit (cores) <InfoTip text="Container CPU cap in cores (fractional ok, e.g. 0.5). Blank/0 = default (1)." /></>}>
        <input
          type="number"
          value={form.cpu_limit}
          onChange={set("cpu_limit")}
          placeholder="1 (platform default)"
          min="0"
          step="0.1"
        />
      </Field>
      <Field
        label={<>Public Domain <InfoTip text="Serve the app on a public HTTPS domain. Off = internal network only. (The public TCP/UDP port below is separate.)" /></>}
        hint={!form.public ? "No public domain; the app's HTTP is internal-only" : undefined}
      >
        <div className="flex justify-start">
          <Checkbox
            checked={form.public}
            onChange={(v) => setForm((f) => ({ ...f, public: v }))}
            label="Expose via public domain"
          />
        </div>
      </Field>
      <Field label={<>Internal Protocol <InfoTip text="How Traefik reaches the app internally. HTTP enables passwords, health paths and sticky sessions; TCP is a raw pass-through for non-HTTP services (Postgres, Redis, game servers)." /></>}>
        <NeoSelect
          value={form.internal_protocol}
          onChange={(v) => {
            const internal_protocol = v as FormState["internal_protocol"];
            // Password, an active health-check path, cookie sticky sessions and
            // the post-deploy HTTP probe are L7-only; clear them when dropping to
            // raw TCP so we never submit a combination the deploy endpoint
            // rejects (and a raw-TCP app can't answer an HTTP probe). Restore the
            // default HTTP probe when returning to HTTP routing.
            setForm((f) => internal_protocol === "tcp"
              ? { ...f, internal_protocol, auth_password: "", sticky: false, health_check_path: "", health_check: false }
              : { ...f, internal_protocol, health_check: true });
          }}
          options={[
            { value: "http", label: "HTTP (L7 routing)" },
            { value: "tcp", label: "TCP (raw pass-through)" },
          ]}
        />
      </Field>
      {/* HTTP/L7-only settings live directly under the protocol select; they
          disappear entirely on raw-TCP routing rather than sitting disabled. */}
      {httpRouted && (
        <>
          <Field label={<>Password Protection <InfoTip text='HTTP basic auth at the ingress (username: admin). HTTP routing only.' /></>}>
            <input
              type="password"
              value={form.auth_password}
              onChange={set("auth_password")}
              placeholder="Optional login gate"
            />
          </Field>
          <HealthCheckField
            enabled={form.health_check}
            path={form.health_check_path}
            onChange={(next) => setForm((f) => ({ ...f, ...next }))}
          />
          <Field label={<>Sticky Sessions <InfoTip text="Keep each visitor on the same replica via a cookie. HTTP routing only." /></>}>
            <div className="flex justify-start">
              <Checkbox
                checked={form.sticky}
                onChange={(v) => setForm((f) => ({ ...f, sticky: v }))}
                label="Pin visitors to one replica"
              />
            </div>
          </Field>
        </>
      )}
      {/* Public-domain-only middleware: the rate limiter, allowlist and gzip all
          live on the public L7 router, so they do nothing until the app is
          exposed via a public domain. Hide them until then rather than showing
          controls that silently no-op. */}
      {form.public && (
        <>
          <Field
            label={<>Rate Limit <InfoTip text="Max requests/sec per client IP on the public domain. 0 = unlimited." /></>}
            hint="requests/sec on the public domain, 0 = unlimited"
          >
            <input
              type="number"
              value={form.rate_limit_rps}
              onChange={set("rate_limit_rps")}
              placeholder="0 (unlimited)"
              min="0"
            />
          </Field>
          <Field label={<>IP Allowlist <InfoTip text="Only these IPs/CIDRs may reach the public domain. Blank = open to all." /></>}>
            <input
              type="text"
              value={form.ip_allowlist}
              onChange={set("ip_allowlist")}
              placeholder="comma-separated IPs or CIDRs"
            />
          </Field>
          <Field label={<>Compression <InfoTip text="gzip responses on the public domain." /></>}>
            <div className="flex justify-start">
              <Checkbox
                checked={form.compress}
                onChange={(v) => setForm((f) => ({ ...f, compress: v }))}
                label="Compress responses on the public domain"
              />
            </div>
          </Field>
        </>
      )}
      <Field
        label={<>Public TCP/UDP Port <InfoTip text="A raw public port straight to the app (game servers, databases, MQTT). Separate from the public domain. Blank = auto-assign." /></>}
        hint={form.public_protocol !== "off" ? `pool ${PUBLIC_PORT_RANGES[form.public_protocol]}` : undefined}
      >
        <div className="flex gap-2">
          <div className={form.public_protocol !== "off" ? "w-24 flex-shrink-0" : "flex-1"}>
            <NeoSelect
              value={form.public_protocol}
              onChange={(v) => setForm((f) => ({ ...f, public_protocol: v as FormState["public_protocol"] }))}
              options={[
                { value: "off", label: "Off" },
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
            />
          </div>
          {form.public_protocol !== "off" && (
            <input
              type="number"
              className="flex-1"
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
            <Field label={<>Path Filter <InfoTip text="Only redeploy when files under this path prefix change. Blank = redeploy on any push to the branch." /></>}>
              <input
                type="text"
                value={form.webhook_path}
                onChange={set("webhook_path")}
                placeholder="e.g. services/api"
              />
            </Field>
            <div className="mt-2">
              <Checkbox
                checked={!!form.webhook_wait_for_ci}
                onChange={(v) => setForm((f) => ({ ...f, webhook_wait_for_ci: v }))}
                label="Wait for CI checks to pass before deploying"
              />
            </div>
            <Field label={<>Deploy to staging first <InfoTip text="Pick an environment to hold each push in a <name>-staging sibling (deployed with that environment) for manual promotion, instead of redeploying production directly. Off = pushes redeploy production." /></>}>
              <NeoSelect
                value={form.webhook_staging_environment_id != null ? String(form.webhook_staging_environment_id) : ""}
                onChange={(v) => setForm((f) => ({ ...f, webhook_staging_environment_id: v ? parseInt(v, 10) : null }))}
                options={[
                  { value: "", label: "Off — deploy production directly" },
                  ...environments.map((env) => ({ value: String(env.id), label: env.name })),
                ]}
              />
            </Field>
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
