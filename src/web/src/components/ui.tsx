import React, { useState, useEffect, useCallback, type ReactNode } from "react";
import { X, AlertTriangle, Loader2, Copy, Check } from "lucide-react";

// --- Toast system ---
type Toast = {
  id: number;
  message: string;
  subtitle?: string;
  type: "success" | "error" | "info";
  sticky?: boolean;
};
let toastId = 0;
let toastListeners: Array<(toasts: Toast[]) => void> = [];
let currentToasts: Toast[] = [];

function notifyToastListeners() {
  toastListeners.forEach((l) => l([...currentToasts]));
}

export function showToast(message: string, type: Toast["type"] = "info") {
  const id = ++toastId;
  currentToasts = [...currentToasts, { id, message, type }];
  notifyToastListeners();
  setTimeout(() => {
    currentToasts = currentToasts.filter((t) => t.id !== id);
    notifyToastListeners();
  }, 4000);
}

/**
 * Create a sticky toast whose message / subtitle / type can be updated in place
 * and which is dismissed explicitly. Used for long-running engine operations.
 */
export function showLiveToast(init: { message: string; subtitle?: string; type?: Toast["type"] }): {
  update: (patch: Partial<Pick<Toast, "message" | "subtitle" | "type">>) => void;
  dismiss: (afterMs?: number) => void;
} {
  const id = ++toastId;
  currentToasts = [
    ...currentToasts,
    { id, message: init.message, subtitle: init.subtitle, type: init.type ?? "info", sticky: true },
  ];
  notifyToastListeners();
  return {
    update: (patch) => {
      currentToasts = currentToasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
      notifyToastListeners();
    },
    dismiss: (afterMs = 0) => {
      setTimeout(() => {
        currentToasts = currentToasts.filter((t) => t.id !== id);
        notifyToastListeners();
      }, afterMs);
    },
  };
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    toastListeners.push(setToasts);
    return () => { toastListeners = toastListeners.filter((l) => l !== setToasts); };
  }, []);

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto animate-slide-up font-mono text-[10px] font-bold uppercase tracking-wider px-4 py-2.5 border-2 border-fg max-w-sm shadow-neo-sm ${
            t.type === "success" ? "bg-accent text-fg" :
            t.type === "error" ? "bg-accent-red text-white" :
            "bg-accent-blue text-white"
          }`}
        >
          <div>{t.message}</div>
          {t.subtitle && (
            <div className="mt-1 text-[9px] font-normal normal-case tracking-normal opacity-80">
              {t.subtitle}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Confirm Dialog ---
type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  danger?: boolean;
  resolve?: (v: boolean) => void;
};

let confirmState: ConfirmState = { open: false, title: "", message: "" };
let confirmListeners: Array<(s: ConfirmState) => void> = [];

function notifyConfirmListeners() {
  confirmListeners.forEach((l) => l({ ...confirmState }));
}

export function confirm(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { open: true, title, message, danger, resolve };
    notifyConfirmListeners();
  });
}

export function ConfirmDialog() {
  const [state, setState] = useState<ConfirmState>({ open: false, title: "", message: "" });

  useEffect(() => {
    confirmListeners.push(setState);
    return () => { confirmListeners = confirmListeners.filter((l) => l !== setState); };
  }, []);

  if (!state.open) return null;

  const close = (v: boolean) => {
    state.resolve?.(v);
    confirmState = { open: false, title: "", message: "" };
    notifyConfirmListeners();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-fg/40 animate-fade-in">
      <div className="bg-bg-raised border-2 border-fg shadow-neo p-6 max-w-md w-full mx-4 animate-slide-up">
        <div className="flex items-start gap-3 mb-4">
          {state.danger && <AlertTriangle size={20} className="text-accent-red mt-0.5 flex-shrink-0" />}
          <div>
            <h3 className="font-mono font-bold text-sm text-fg uppercase">{state.title}</h3>
            <p className="text-xs text-fg-dim mt-1">{state.message}</p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={() => close(false)} className="font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg bg-bg-raised text-fg-dim px-3 py-1.5 shadow-neo-sm hover:bg-alt transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none">
            Cancel
          </button>
          <button
            onClick={() => close(true)}
            className={`font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg px-3 py-1.5 shadow-neo-sm transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none ${
              state.danger
                ? "bg-accent-red text-white"
                : "bg-accent text-fg"
            }`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Portal anchor rect ---
// getBoundingClientRect returns real viewport pixels, but position:fixed portals
// live inside the `html { zoom }` coordinate space (index.html), so the zoom
// must be divided back out or the portal lands offset by the zoom factor.
export function portalAnchorRect(el: Element) {
  const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
  const r = el.getBoundingClientRect();
  return {
    top: r.top / zoom,
    bottom: r.bottom / zoom,
    left: r.left / zoom,
    right: r.right / zoom,
    width: r.width / zoom,
    height: r.height / zoom,
  };
}

// --- Spinner ---
export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 size={16} className={`animate-spin text-fg ${className}`} />;
}

// --- Copy Button ---
export function CopyButton({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="p-1 text-muted hover:text-fg transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={size} className="text-green-500" /> : <Copy size={size} />}
    </button>
  );
}

// --- Status Badge ---
export function StatusBadge({ status, subLabel }: { status: string; subLabel?: string }) {
  const s = status?.toLowerCase() || "unknown";
  const dotColor =
    s === "running" ? "bg-accent" :
    s === "deploying" || s === "waking" ? "bg-accent-amber" :
    s === "sleeping" ? "bg-accent-amber" :
    s === "paused" ? "bg-alt" :
    s === "unhealthy" ? "bg-accent-amber" :
    s === "error" || s === "failed" ? "bg-accent-red" :
    "bg-alt";

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-fg">
      <span className={`w-[7px] h-[7px] border-[1.5px] border-fg flex-shrink-0 ${dotColor} ${s === "deploying" || s === "waking" ? "pulse" : ""}`} />
      {status}
      {subLabel && (
        <span className="font-mono text-[9px] text-muted font-normal normal-case tracking-normal">· {subLabel}</span>
      )}
    </span>
  );
}

// --- Card ---
export function Card({ children, className = "" }: { children: ReactNode; className?: string; accent?: boolean }) {
  return (
    <div className={`bg-bg-raised border-2 border-fg shadow-neo ${className}`}>
      {children}
    </div>
  );
}

// --- Btn ---
export function Btn({
  children,
  onClick,
  type = "button",
  variant = "default",
  size = "sm",
  disabled = false,
  loading = false,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "xs" | "sm";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
}) {
  const base = "inline-flex items-center gap-1.5 font-mono font-bold uppercase tracking-wider border-2 border-fg cursor-pointer transition-all disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-neo-sm disabled:translate-x-0 disabled:translate-y-0";
  const sizes = size === "xs" ? "px-2 py-1 text-[9px]" : "px-3 py-1.5 text-[10px]";

  const variants = {
    default: "bg-bg-raised text-fg shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    primary: "bg-accent text-fg shadow-neo-sm hover:bg-accent-h hover:-translate-x-px hover:-translate-y-px hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    danger: "bg-accent-red text-white shadow-neo-sm hover:-translate-x-px hover:-translate-y-px hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    ghost: "bg-bg-raised text-fg-dim shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
  };

  const { node: renderedChildren, found: iconReplaced } = loading
    ? replaceFirstIconWithSpinner(children)
    : { node: children, found: false };

  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} title={title} className={`${base} ${sizes} ${variants[variant]} ${className}`}>
      {loading && !iconReplaced && <Loader2 size={size === "xs" ? 12 : 13} className="animate-spin flex-shrink-0" />}
      {renderedChildren}
    </button>
  );
}

// Walk children and swap the first Lucide-style icon element (detected by a
// numeric `size` prop) for a same-size spinner, so a loading button shows a
// spinner where its icon was instead of spinning the icon itself. Returns the
// transformed tree and whether an icon was found, so Btn can prepend a spinner
// for icon-less buttons.
function replaceFirstIconWithSpinner(node: ReactNode): { node: ReactNode; found: boolean } {
  let found = false;
  const visit = (child: ReactNode): ReactNode => {
    if (found || !React.isValidElement(child)) return child;
    const props = child.props as { size?: unknown; className?: string; children?: ReactNode };
    if (typeof props.size === "number") {
      found = true;
      return <Loader2 key={child.key ?? undefined} size={props.size} className="animate-spin flex-shrink-0" />;
    }
    if (props.children !== undefined) {
      const newChildren = React.Children.map(props.children, visit);
      if (found) return React.cloneElement(child, {}, newChildren);
    }
    return child;
  };
  const result = React.Children.map(node, visit);
  return { node: result, found };
}

// --- Table ---
export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b-2 border-fg">
            {headers.map((h) => (
              <th key={h} className="text-left py-2.5 px-3 font-bold uppercase tracking-wider text-[9px] text-fg">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-fg/10">{children}</tbody>
      </table>
    </div>
  );
}

// --- Checkbox ---
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer group">
      <span
        onClick={(e) => { e.preventDefault(); onChange(!checked); }}
        className={`w-4 h-4 border-2 border-fg flex-shrink-0 flex items-center justify-center transition-colors ${checked ? "bg-accent" : "bg-bg-raised group-hover:bg-alt"}`}
      >
        {checked && <span className="block w-2 h-2 bg-fg" />}
      </span>
      {label && <span className="font-mono text-[10px] text-fg">{label}</span>}
    </label>
  );
}

// --- Field ---
// A settings-style row: label (left) + control (right) on one line. The control
// column is right-bound and width-capped so inputs align down the right edge.
// Drop any control inside — inputs, NeoSelect, and textareas are all width:100%
// so they fill the column. Use `align="start"` for multi-line controls
// (textareas) and `wide` for controls that need a roomier column. Pass
// `divider` to draw a hairline rule between rows (off by default).
export function Field({
  label,
  hint,
  children,
  className = "",
  align = "center",
  wide = false,
  divider = false,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "center" | "start";
  wide?: boolean;
  divider?: boolean;
  htmlFor?: string;
}) {
  const col = wide ? "w-[min(75%,34rem)]" : "w-[min(62%,20rem)]";
  return (
    <div
      className={`flex ${align === "start" ? "items-start" : "items-center"} justify-between gap-4 py-3 ${
        divider ? "border-b-2 border-fg/10 last:border-b-0" : ""
      } ${className}`}
    >
      {(label || hint) && (
        <div className={`min-w-0 ${align === "start" ? "pt-1.5" : ""}`}>
          {label && (
            <label htmlFor={htmlFor} className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg leading-tight block">
              {label}
            </label>
          )}
          {hint && <div className="font-mono text-[9px] text-muted normal-case tracking-normal mt-1 leading-snug">{hint}</div>}
        </div>
      )}
      <div className={`shrink-0 ${col}`}>{children}</div>
    </div>
  );
}

// --- Divider ---
// A hairline rule for separating logical sections of a form/card.
export function Divider({ className = "" }: { className?: string }) {
  return <div className={`border-t-2 border-fg/10 ${className}`} />;
}

// --- Empty State ---
export function EmptyState({ message, icon: Icon }: { message: string; icon?: React.ComponentType<{ size?: number; className?: string }> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted">
      {Icon && <Icon size={32} className="mb-3 opacity-30" />}
      <p className="font-mono text-[10px] uppercase tracking-wider">{message}</p>
    </div>
  );
}
