import { AlertTriangle } from "lucide-react";
import { Card } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { ReceiptRow } from "./shared.tsx";
import type { IntrospectResult, FormState } from "./types.ts";

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  detected: (IntrospectResult & { ok: true }) | null;
  selectedManifest: number | null;
};

export function ReceiptSection({ form, set, setForm, detected, selectedManifest }: Props) {
  const hasBothModes = !!detected && detected.dockerfiles.length > 0 && !!detected.compose_files[0];
  const isCompose = !!(form.compose_file || (!form.dockerfile_path && detected?.compose_files[0]));
  const hasMultipleDockerfiles = !isCompose && !!detected && detected.dockerfiles.length > 1;
  const hasMultipleComposeFiles = isCompose && !!detected && detected.compose_files.length > 1;
  const hasMultipleServices = !!detected && detected.compose_services.length > 1;

  return (
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

        {hasBothModes && selectedManifest == null && (
          <ReceiptRow label="Build Mode" detected>
            <NeoSelect
              value={isCompose ? "compose" : "dockerfile"}
              onChange={(v) => {
                if (v === "compose") {
                  setForm((f) => ({
                    ...f,
                    compose_file: detected?.compose_files[0] || "docker-compose.yml",
                    compose_web_service: detected?.suggested_web_service || "",
                    dockerfile_path: "",
                  }));
                } else {
                  setForm((f) => ({
                    ...f,
                    compose_file: "",
                    compose_web_service: "",
                    dockerfile_path: detected?.dockerfiles[0] || "",
                  }));
                }
              }}
              options={[
                { value: "compose", label: "Docker Compose" },
                { value: "dockerfile", label: "Dockerfile" },
              ]}
            />
          </ReceiptRow>
        )}

        <ReceiptRow
          label={isCompose ? "Compose" : "Dockerfile"}
          detected={!!detected && (detected.dockerfiles.length > 0 || isCompose)}
        >
          {isCompose && hasMultipleComposeFiles ? (
            <NeoSelect
              value={form.compose_file}
              onChange={(v) => setForm((f) => ({ ...f, compose_file: v }))}
              options={detected!.compose_files.map((c) => ({ value: c, label: c }))}
            />
          ) : isCompose ? (
            <input
              type="text"
              value={form.compose_file}
              onChange={set("compose_file")}
              placeholder={detected?.compose_files[0] || "docker-compose.yml"}
            />
          ) : hasMultipleDockerfiles ? (
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

        {!isCompose && (
          <ReceiptRow label="Build Context" detected={!!form.docker_context}>
            <input
              type="text"
              value={form.docker_context}
              onChange={set("docker_context")}
              placeholder=". (repo root)"
            />
          </ReceiptRow>
        )}

        {isCompose && (
          <ReceiptRow label="Web Service" detected={!!form.compose_web_service}>
            {hasMultipleServices ? (
              <NeoSelect
                value={form.compose_web_service}
                onChange={(v) => setForm((f) => ({ ...f, compose_web_service: v }))}
                options={detected!.compose_services.map((s) => ({
                  value: s.name,
                  label: s.has_ports ? `${s.name}  ·  exposes port` : s.name,
                }))}
              />
            ) : (
              <input
                type="text"
                value={form.compose_web_service}
                onChange={set("compose_web_service")}
                placeholder="Service name to route traffic to"
              />
            )}
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
  );
}
