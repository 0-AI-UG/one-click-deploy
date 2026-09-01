import { useState, useEffect, useRef, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { portalAnchorRect } from "./ui.tsx";

export type SelectOption = { value: string; label: string };

export function NeoSelect({ value, options, onChange, placeholder, compact, disabled }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const r = portalAnchorRect(triggerRef.current);
      setPos({ top: r.bottom, left: r.left, width: r.width });
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
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((index) => (index + direction + options.length) % Math.max(1, options.length));
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(highlighted);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-activedescendant={open && options[highlighted] ? `${listboxId}-${highlighted}` : undefined}
        className={`w-full text-left bg-bg-raised border-2 border-fg font-mono flex items-center transition-all ${
          disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
        } ${compact ? "px-1.5 py-[3px] text-[9px]" : "px-2.5 py-[7px] text-[10px]"
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
          id={listboxId}
          role="listbox"
          data-neoselect-menu
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-50 bg-bg-raised border-2 border-fg shadow-neo max-h-40 overflow-auto"
        >
          {options.length === 0 && (
            <div className={`font-mono text-muted ${compact ? "px-1.5 py-1 text-[9px]" : "px-2.5 py-1.5 text-[10px]"}`}>
              No options
            </div>
          )}
          {options.map(opt => (
            <button
              key={opt.value}
              id={`${listboxId}-${options.indexOf(opt)}`}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onMouseEnter={() => setHighlighted(options.indexOf(opt))}
              onClick={() => choose(options.indexOf(opt))}
              className={`w-full text-left block font-mono border-b border-fg cursor-pointer text-fg ${
                compact ? "px-1.5 py-1 text-[9px]" : "px-2.5 py-1.5 text-[10px]"
              } ${options.indexOf(opt) === highlighted ? "bg-alt" : "bg-transparent"} ${opt.value === value ? "font-bold" : ""}`}
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
