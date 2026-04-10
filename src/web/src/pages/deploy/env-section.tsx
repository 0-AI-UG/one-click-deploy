import { Card } from "../../components/ui.tsx";
import type { ManifestEnvDef } from "./types.ts";

type Props = {
  envValues: Record<string, string>;
  setEnvValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  manifestEnvDefs: ManifestEnvDef[];
};

export function EnvSection({ envValues, setEnvValues, manifestEnvDefs }: Props) {
  const envKeys = Object.keys(envValues);
  if (envKeys.length === 0) return null;

  return (
    <Card className="p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          {manifestEnvDefs.length > 0 ? "Configuration" : "Secrets"}
        </span>
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
    </Card>
  );
}
