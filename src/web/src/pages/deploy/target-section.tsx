import { Check, Layers } from "lucide-react";
import type { DeployTarget } from "./types.ts";

type Props = {
  targets: Record<string, DeployTarget>;
  appName: string;
  selected: string;
  onSelect: (target: string) => void;
};

// Deploy-target picker. Shown only when the selected manifest declares a
// `targets` block. Selecting a non-production target deploys an isolated
// `<name>-<target>` sibling (own environment, own server pool); "Production"
// keeps the bare app name. Derivation mirrors src/cli/commands/deploy.ts.
export function TargetSection({ targets, appName, selected, onSelect }: Props) {
  const keys = Object.keys(targets);
  if (keys.length === 0) return null;

  const hasProduction = keys.includes("production");
  // The first option is always "Production" (the bare app). It carries the
  // "production" tag when the manifest declares it, otherwise the empty target
  // (unchanged, untagged deploy of the bare name).
  const options: Array<{ value: string; label: string; sibling?: string }> = [
    { value: hasProduction ? "production" : "", label: "Production" },
    ...keys
      .filter((k) => k !== "production")
      .map((k) => ({ value: k, label: k, sibling: `${appName || "app"}-${k}` })),
  ];

  return (
    <div className="px-5 py-4 animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Layers size={14} className="text-fg" />
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          Deploy target
        </span>
      </div>
      <p className="text-fg-dim text-[11px] mb-3">
        A non-production target deploys an isolated{" "}
        <span className="font-mono font-bold text-fg">&lt;name&gt;-&lt;target&gt;</span> sibling
        with its own environment on a separate server pool.
      </p>
      <div className="space-y-2">
        {options.map((opt) => {
          const isSelected = selected === opt.value;
          return (
            <button
              key={opt.value || "__production__"}
              type="button"
              onClick={() => onSelect(opt.value)}
              className={`w-full text-left border-2 px-4 py-2.5 transition-colors flex items-center gap-3 ${
                isSelected
                  ? "border-fg bg-accent/20 shadow-neo-sm"
                  : "border-fg/30 hover:border-fg hover:bg-alt"
              }`}
            >
              <div className="min-w-0">
                <div className="font-mono text-[11px] font-bold text-fg truncate">
                  {opt.label}
                </div>
                {opt.sibling && (
                  <div className="font-mono text-[10px] text-fg-dim truncate">
                    deploys {opt.sibling}
                  </div>
                )}
              </div>
              {isSelected && (
                <Check size={14} strokeWidth={3} className="ml-auto text-fg flex-shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
