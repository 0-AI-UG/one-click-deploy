import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { NeoSelect } from "../../components/neo-select.tsx";
import type { ManifestEnvDef } from "./types.ts";
import type { EnvironmentData } from "../../types.ts";

type Props = {
  envValues: Record<string, string>;
  setEnvValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  manifestEnvDefs: ManifestEnvDef[];
  selectedEnvironmentId: number | null;
  onEnvironmentChange: (id: number | null) => void;
};

export function EnvSection({ envValues, setEnvValues, manifestEnvDefs, selectedEnvironmentId, onEnvironmentChange }: Props) {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);

  useEffect(() => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  const envKeys = Object.keys(envValues);
  const showEnvInputs = !selectedEnvironmentId && envKeys.length > 0;
  const selectedEnv = environments.find((e) => e.id === selectedEnvironmentId);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          Environment
        </span>
      </div>

      {environments.length > 0 && (
        <div className="mb-3">
          <NeoSelect
            value={selectedEnvironmentId != null ? String(selectedEnvironmentId) : "new"}
            onChange={(v) => onEnvironmentChange(v === "new" ? null : parseInt(v))}
            options={[
              { value: "new", label: "Create new environment" },
              ...environments.map((env) => ({
                value: String(env.id),
                label: `${env.name} — ${env.env_vars.length} var${env.env_vars.length !== 1 ? "s" : ""}`,
              })),
            ]}
          />
        </div>
      )}

      {selectedEnv && (
        <div className="space-y-1">
          <p className="font-mono text-[9px] text-muted uppercase tracking-wider">
            Using environment "{selectedEnv.name}" — edit variables on the{" "}
            <a href="#/environments" className="font-bold text-accent-blue hover:underline">Environments page</a>
          </p>
          {selectedEnv.env_vars.length > 0 && (
            <div className="mt-2 space-y-1">
              {selectedEnv.env_vars.map((v) => (
                <div key={v.key} className="font-mono text-[10px] text-fg-dim flex gap-2">
                  <span className="font-bold text-fg">{v.key}</span>
                  <span>{v.secret ? "••••••••" : v.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showEnvInputs && (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
              {manifestEnvDefs.length > 0 ? "From deploy manifest" : "Detected from .env.example"}
            </span>
          </div>
          <div className="space-y-3">
            {envKeys.map((key) => {
              const def = manifestEnvDefs.find((e) => e.key === key);
              return (
                <div key={key}>
                  <div className="grid grid-cols-[40%_1fr] gap-2 items-center">
                    <div className="font-mono text-[10px] font-bold text-fg truncate flex items-center gap-1.5" title={key}>
                      {key}
                      {def?.required && !envValues[key]?.trim() && (
                        <span className="text-accent-red text-[9px] font-bold">required</span>
                      )}
                    </div>
                    <input
                      type={def?.secret ? "password" : "text"}
                      value={envValues[key]}
                      placeholder={def?.secret ? "••••••" : "value"}
                      onChange={(e) =>
                        setEnvValues((p) => ({ ...p, [key]: e.target.value }))
                      }
                    />
                  </div>
                  {def?.description && (
                    <div className="font-mono text-[9px] text-fg-dim mt-0.5 ml-[40%] pl-2">
                      {def.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {!selectedEnvironmentId && envKeys.length === 0 && environments.length === 0 && (
        <p className="font-mono text-[9px] text-muted">
          No environment variables detected. An empty environment will be created.
        </p>
      )}
    </div>
  );
}
