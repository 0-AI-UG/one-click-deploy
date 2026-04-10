import { useState } from "react";
import { ChevronDown, ChevronRight, Check } from "lucide-react";

export const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">
    {children}
  </label>
);

export function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-2 border-fg shadow-neo-sm bg-bg-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-alt transition-colors"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-fg">
          {title}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-3 border-t-2 border-fg">{children}</div>}
    </div>
  );
}

export function ReceiptRow({
  label,
  children,
  detected,
}: {
  label: string;
  children: React.ReactNode;
  detected?: boolean;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 items-start py-3 border-b-2 border-fg/15 last:border-b-0">
      <div className="pt-2.5 flex items-center gap-1.5">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">
          {label}
        </span>
        {detected && (
          <span title="Auto-detected" className="text-accent-green">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}
