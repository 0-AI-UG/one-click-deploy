import { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { NeoSelect } from "../../components/neo-select.tsx";
import { ReceiptRow } from "./shared.tsx";
import { get } from "../../api/client.ts";
import type { IntrospectResult, FormState } from "./types.ts";

type ServerOption = { id: number; name: string; type: string; location: string; status: string };

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  detected: (IntrospectResult & { ok: true }) | null;
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
        <ReceiptRow label="App Name" detected={!!detected}>
          <input type="text" value={form.app_name} onChange={set("app_name")} required />
        </ReceiptRow>

        <ReceiptRow
          label="Dockerfile"
          detected={!!detected && detected.dockerfiles.length > 0}
        >
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
        </ReceiptRow>

        <ReceiptRow label="Build Context" detected={!!form.docker_context}>
          <input
            type="text"
            value={form.docker_context}
            onChange={set("docker_context")}
            placeholder=". (repo root)"
          />
        </ReceiptRow>

        {detected && detected.branches.length > 0 && (
          <ReceiptRow label="Branch" detected>
            <NeoSelect
              value={form.git_branch || detected.default_branch}
              onChange={onBranchChange}
              options={detected.branches.map((b) => ({
                value: b,
                label: b === detected.default_branch ? `${b}  ·  default` : b,
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

        {servers.length > 0 && (
          <ReceiptRow label="Target Server">
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
          </ReceiptRow>
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
