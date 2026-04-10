import { Check, Package, Settings2 } from "lucide-react";
import { Card } from "../../components/ui.tsx";
import type { IntrospectResult } from "./types.ts";

type Props = {
  detected: IntrospectResult & { ok: true };
  selectedManifest: number | null;
  onSelect: (idx: number) => void;
  onClear: () => void;
};

export function ManifestSection({ detected, selectedManifest, onSelect, onClear }: Props) {
  if (detected.manifests.length === 0) return null;

  if (detected.manifests.length > 1) {
    return (
      <Card className="p-5 animate-fade-in">
        <div className="mb-3">
          <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
            Pick a service to deploy
          </span>
          <p className="text-fg-dim text-[11px] mt-1">
            This repo has {detected.manifests.length} deploy manifests.
          </p>
        </div>
        <div className="space-y-2">
          {detected.manifests.map((pm, idx) => (
            <button
              key={pm.path}
              type="button"
              onClick={() => onSelect(idx)}
              className={`w-full text-left border-2 px-4 py-3 transition-colors flex items-center gap-3 ${
                selectedManifest === idx
                  ? "border-fg bg-accent/20 shadow-neo-sm"
                  : "border-fg/30 hover:border-fg hover:bg-alt"
              }`}
            >
              {pm.manifest.icon ? (
                <img src={pm.manifest.icon} alt="" className="w-6 h-6 flex-shrink-0" />
              ) : (
                <Package size={16} className="text-fg flex-shrink-0" />
              )}
              <div className="min-w-0">
                <div className="font-mono text-[11px] font-bold text-fg truncate">
                  {pm.manifest.name}
                </div>
                {pm.manifest.description && (
                  <div className="font-mono text-[10px] text-fg-dim truncate">
                    {pm.manifest.description}
                  </div>
                )}
              </div>
              {selectedManifest === idx && (
                <Check size={14} strokeWidth={3} className="ml-auto text-fg flex-shrink-0" />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            className={`w-full text-left border-2 px-4 py-3 transition-colors flex items-center gap-3 ${
              selectedManifest === null
                ? "border-fg bg-alt shadow-neo-sm"
                : "border-fg/30 hover:border-fg hover:bg-alt"
            }`}
          >
            <Settings2 size={16} className="text-fg-dim flex-shrink-0" />
            <span className="font-mono text-[11px] text-fg-dim">Configure manually</span>
          </button>
        </div>
      </Card>
    );
  }

  // Single manifest banner
  if (selectedManifest === 0) {
    return (
      <div className="flex items-center justify-between bg-accent/10 border-2 border-fg px-4 py-2.5 animate-fade-in">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-fg" />
          <span className="font-mono text-[10px] font-bold text-fg">
            {detected.manifests[0].manifest.name}
          </span>
          {detected.manifests[0].manifest.description && (
            <span className="font-mono text-[10px] text-fg-dim">
              — {detected.manifests[0].manifest.description}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-[9px] uppercase tracking-wider text-fg-dim hover:text-fg transition-colors"
        >
          Configure manually
        </button>
      </div>
    );
  }

  return null;
}
