import { Plus, Minus, AlertTriangle } from "lucide-react";
import { Btn, Checkbox } from "../../components/ui.tsx";
import { Label, Section } from "./shared.tsx";
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
    <Section title="Advanced">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Replicas</Label>
          <input
            type="number"
            value={form.domain ? form.replicas : "1"}
            onChange={set("replicas")}
            min="1"
            disabled={!form.domain}
            title={!form.domain ? "Add a custom domain to enable scaling" : undefined}
          />
          {!form.domain && <p className="text-[9px] text-muted mt-1">Requires a custom domain</p>}
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
          checked={form.public}
          onChange={(v) => setForm((f) => ({ ...f, public: v }))}
          label="Public access (expose via public domain)"
        />
        {!form.public && <p className="text-[9px] text-muted mt-1">App will only be reachable over the internal network</p>}
      </div>
      <div>
        <Checkbox
          checked={!!form.webhook_enabled}
          onChange={(v) => setForm((f) => ({ ...f, webhook_enabled: v }))}
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
  );
}
