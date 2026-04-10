import { Info } from "lucide-react";

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center text-muted hover:text-fg cursor-help group">
      <Info size={11} />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-[9px] font-mono text-fg bg-bg border-2 border-fg shadow-neo-sm whitespace-normal max-w-[220px] w-max opacity-0 group-hover:opacity-100 transition-opacity z-50">
        {text}
      </span>
    </span>
  );
}

export function Sparkline({ values, color = "#3b82f6" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <span className="text-[9px] text-muted font-mono">no data</span>;
  const w = 120, h = 24;
  const max = Math.max(100, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
