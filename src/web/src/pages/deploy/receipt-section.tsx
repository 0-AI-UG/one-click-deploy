import { useState, useEffect } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { NeoSelect } from "../../components/neo-select.tsx";
import { Field } from "../../components/ui.tsx";
import { get } from "../../api/client.ts";
import type { AppIntrospect, FormState } from "./types.ts";

type ServerOption = { id: number; name: string; type: string; location: string; status: string };

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  detected: AppIntrospect | null;
  onBranchChange: (branch: string) => void;
};

export function ReceiptSection({ form, set, setForm, detected, onBranchChange }: Props) {
  const [servers, setServers] = useState<ServerOption[]>([]);
  useEffect(() => {
    get("/api/resources")
      .then((res: any) => {
        const ready = (res.servers || []).filter((s: any) => s.status === "ready");
        setServers(ready);
      })
      .catch(() => {});
  }, []);

  const hasMultipleDockerfiles = !!detected && detected.dockerfiles.length > 1;

  // Green check adornment shown next to a Field label when the value was
  // auto-detected from the repo (was the ReceiptRow `detected` prop).
  const mark = (show: boolean) =>
    show ? (
      <span title="Auto-detected" className="text-accent-green">
        <Check size={11} strokeWidth={3} />
      </span>
    ) : null;

  return (
    <div className="p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          Configuration
        </span>
        {detected && (
          <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
            {detected.owner}/{detected.repo}
          </span>
        )}
      </div>

      <div>
        <Field label={<span className="inline-flex items-center gap-1.5">App Name{mark(!!detected)}</span>}>
          <input type="text" value={form.app_name} onChange={set("app_name")} required />
        </Field>

        <Field label={<span className="inline-flex items-center gap-1.5">Dockerfile{mark(!!detected && detected.dockerfiles.length > 0)}</span>}>
          {hasMultipleDockerfiles ? (
            <NeoSelect
              value={form.dockerfile_path}
              onChange={(v) => setForm((f) => ({ ...f, dockerfile_path: v }))}
              options={detected!.dockerfiles.map((d) => ({ value: d, label: d }))}
            />
          ) : (
            <input
              type="text"
              value={form.dockerfile_path}
              onChange={set("dockerfile_path")}
              placeholder="Auto-detect at deploy time"
            />
          )}
        </Field>

        <Field label={<span className="inline-flex items-center gap-1.5">Build Context{mark(!!form.docker_context)}</span>}>
          <input
            type="text"
            value={form.docker_context}
            onChange={set("docker_context")}
            placeholder=". (repo root)"
          />
        </Field>

        {detected && detected.branches.length > 0 && (
          <Field label={<span className="inline-flex items-center gap-1.5">Branch{mark(true)}</span>}>
            <NeoSelect
              value={form.git_branch || detected.default_branch}
              onChange={onBranchChange}
              options={detected.branches.map((b) => ({
                value: b,
                label: b === detected.default_branch ? `${b}  ·  default` : b,
              }))}
            />
          </Field>
        )}

        <Field label={<span className="inline-flex items-center gap-1.5">Listens On{mark(!!detected?.detected_port)}</span>}>
          <input type="number" value={form.container_port} onChange={set("container_port")} />
        </Field>

        <Field label="Domain">
          <input
            type="text"
            value={form.domain}
            onChange={set("domain")}
            placeholder="app.example.com (we'll give you a temporary one if blank)"
          />
        </Field>

        {servers.length > 0 && (
          <Field label="Target Server">
            <NeoSelect
              value={form.server_id}
              onChange={(v) => setForm((f) => ({ ...f, server_id: v }))}
              options={[
                { value: "", label: "Auto (first available)" },
                ...servers.map((s) => ({
                  value: String(s.id),
                  label: `${s.name} (${s.type} · ${s.location})`,
                })),
              ]}
            />
          </Field>
        )}
      </div>

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
    </div>
  );
}
