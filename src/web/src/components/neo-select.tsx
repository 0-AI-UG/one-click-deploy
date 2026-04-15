import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

export type SelectOption = { value: string; label: string };

export function NeoSelect({ value, options, onChange, placeholder, compact }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
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
      {open && pos && createPortal(
        <div
          ref={menuRef}
          data-neoselect-menu
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-50 bg-bg-raised border-2 border-fg shadow-neo max-h-40 overflow-auto"
        >
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
        </div>,
        document.body,
      )}
    </>
  );
}
