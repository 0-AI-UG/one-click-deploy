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
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mono"
        style={{
          width: '100%', textAlign: 'left',
          background: 'var(--bg-raised)', border: 'var(--b)',
          padding: compact ? '3px 6px' : '7px 10px', fontSize: compact ? 9 : 10, color: 'var(--fg)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          transition: 'box-shadow .1s, transform .1s',
          boxShadow: open ? 'var(--shadow-sm)' : 'none',
          transform: open ? 'translate(-1px,-1px)' : 'none',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: (!value && placeholder) ? 'var(--fg-faint)' : undefined }}>
          {selected?.label || value || placeholder || ''}
        </span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, marginLeft: 6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--bg-raised)', border: 'var(--b)', borderTop: 'none',
          boxShadow: 'var(--shadow)',
          maxHeight: 160, overflow: 'auto',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="mono"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                width: '100%', textAlign: 'left', display: 'block',
                padding: compact ? '4px 6px' : '6px 10px', fontSize: compact ? 9 : 10,
                background: opt.value === value ? 'var(--accent)' : 'transparent',
                color: 'var(--fg)', border: 'none', borderBottom: '1px solid var(--fg)',
                cursor: 'pointer', fontWeight: opt.value === value ? 700 : 400,
              }}
              onMouseEnter={e => { if (opt.value !== value) (e.target as HTMLElement).style.background = 'var(--bg-alt)'; }}
              onMouseLeave={e => { if (opt.value !== value) (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
