import { Loader2, Check, AlertTriangle } from "lucide-react";
import { Field } from "../../components/ui.tsx";
import type { IntrospectResult, FormState } from "./types.ts";

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  introspecting: boolean;
  introspect: IntrospectResult | null;
};

export function RepoSection({ form, set, introspecting, introspect }: Props) {
  const detected = introspect?.ok === true ? introspect : null;

  return (
    <div className="p-5">
      <Field label="Git Repository">
        <input
          type="text"
          value={form.git_repo}
          onChange={set("git_repo")}
          placeholder="https://github.com/user/repo"
          required
          autoFocus
          className="!text-[12px] !py-3"
        />
      </Field>

      <div className="mt-3 min-h-[18px] flex items-center justify-between font-mono text-[10px]">
        <div className="flex items-center gap-2">
          {introspecting && (
            <>
              <Loader2 size={12} className="animate-spin text-fg" />
              <span className="text-fg-dim">Peeking at the repo</span>
            </>
          )}
          {!introspecting && detected && (
            <>
              <Check size={12} strokeWidth={3} className="text-fg bg-accent border-2 border-fg" />
              <span className="text-fg">
                {detected.manifests.length > 0
                  ? detected.manifests.length === 1
                    ? `Deploy manifest found`
                    : `${detected.manifests.length} deploy manifests found`
                  : <>
                      Found {detected.dockerfiles.length > 0 ? "Dockerfile" : "repo"}
                      {detected.detected_port ? ` · port ${detected.detected_port}` : ""}
                      {detected.env_vars.length > 0
                        ? ` · ${detected.env_vars.length} env var${detected.env_vars.length === 1 ? "" : "s"}`
                        : ""}
                    </>}
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
        <a href="/llm.txt" target="_blank" rel="noopener noreferrer" className="text-[9px] text-fg-dim hover:text-fg transition-colors uppercase tracking-wider">
          Manifest docs
        </a>
      </div>
    </div>
  );
}
