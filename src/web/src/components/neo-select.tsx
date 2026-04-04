import { useState, useEffect, useRef } from "react";

export type SelectOption = { value: string; label: string };

export function NeoSelect({ value, options, onChange, placeholder, compact }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left bg-bg-raised border-2 border-fg font-mono cursor-pointer flex items-center transition-all ${
          compact ? "px-1.5 py-[3px] text-[9px]" : "px-2.5 py-[7px] text-[10px]"
        } ${open ? "shadow-neo-sm -translate-x-px -translate-y-px" : ""}`}
      >
        <span className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${(!value && placeholder) ? "text-muted" : "text-fg"}`}>
          {selected?.label || value || placeholder || ""}
        </span>
        <svg
          width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          className={`flex-shrink-0 ml-1.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-bg-raised border-2 border-fg border-t-0 shadow-neo max-h-40 overflow-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left block font-mono border-b border-fg cursor-pointer text-fg ${
                compact ? "px-1.5 py-1 text-[9px]" : "px-2.5 py-1.5 text-[10px]"
              } ${opt.value === value ? "bg-accent font-bold" : "bg-transparent hover:bg-alt"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
