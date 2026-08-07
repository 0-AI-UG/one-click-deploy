import React, { useState, useEffect, useCallback, type ReactNode } from "react";
import { X, AlertTriangle, Loader2, Copy, Check } from "lucide-react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";

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
  const isMobile = useMobileLayout();

  useEffect(() => {
    toastListeners.push(setToasts);
    return () => { toastListeners = toastListeners.filter((l) => l !== setToasts); };
  }, []);

  return (
    <div className={isMobile ? "pointer-events-none fixed inset-x-3 top-[calc(62px+env(safe-area-inset-top))] z-[100] flex flex-col gap-2" : "fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto animate-slide-up font-mono text-[10px] font-bold uppercase tracking-wider px-4 py-2.5 border-2 border-fg ${isMobile ? "w-full" : "max-w-sm"} shadow-neo-sm ${
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
  requiredText?: string;
  requiredTextLabel?: string;
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

export function confirmWithText(
  title: string,
  message: string,
  requiredText: string,
  requiredTextLabel: string,
  danger = true,
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { open: true, title, message, danger, requiredText, requiredTextLabel, resolve };
    notifyConfirmListeners();
  });
}

export function ConfirmDialog() {
  const [state, setState] = useState<ConfirmState>({ open: false, title: "", message: "" });
  const [typedText, setTypedText] = useState("");
  const isMobile = useMobileLayout();

  useEffect(() => {
    confirmListeners.push(setState);
    return () => { confirmListeners = confirmListeners.filter((l) => l !== setState); };
  }, []);

  useEffect(() => {
    setTypedText("");
  }, [state.open, state.requiredText]);

  if (!state.open) return null;

  const close = (v: boolean) => {
    state.resolve?.(v);
    confirmState = { open: false, title: "", message: "" };
    notifyConfirmListeners();
  };

  return (
    <div className={`fixed inset-0 z-[90] flex bg-fg/40 animate-fade-in ${isMobile ? "items-end" : "items-center justify-center"}`}>
      <div className={isMobile ? "w-full rounded-t-[22px] border-2 border-b-0 border-fg bg-bg-raised px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 shadow-[0_-5px_0_#1A1A1A] animate-slide-up" : "bg-bg-raised border-2 border-fg shadow-neo p-6 max-w-md w-full mx-4 animate-slide-up"}>
        {isMobile && <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-fg/25" />}
        <div className="flex items-start gap-3 mb-4">
          {state.danger && <AlertTriangle size={20} className="text-accent-red mt-0.5 flex-shrink-0" />}
          <div>
            <h3 className="font-mono font-bold text-sm text-fg uppercase">{state.title}</h3>
            <p className="text-xs text-fg-dim mt-1">{state.message}</p>
          </div>
        </div>
        {state.requiredText !== undefined && (
          <div className="mb-4">
            <label className="block font-mono text-[10px] font-bold text-fg mb-2" htmlFor="typed-confirmation">
              {state.requiredTextLabel}
            </label>
            <input
              id="typed-confirmation"
              type="text"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && typedText.trim() === state.requiredText) close(true);
                if (event.key === "Escape") close(false);
              }}
              autoComplete="off"
              autoFocus
              className="w-full border-2 border-fg bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:shadow-neo-sm"
            />
          </div>
        )}
        <div className={`flex gap-2 justify-end ${isMobile ? "mt-5" : ""}`}>
          <button onClick={() => close(false)} className={`font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg bg-bg-raised text-fg-dim shadow-neo-sm hover:bg-alt transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none ${isMobile ? "min-h-12 flex-1 px-4" : "px-3 py-1.5"}`}>
            Cancel
          </button>
          <button
            onClick={() => close(true)}
            disabled={state.requiredText !== undefined && typedText.trim() !== state.requiredText}
            className={`font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg shadow-neo-sm transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none ${isMobile ? "min-h-12 flex-1 px-4" : "px-3 py-1.5"} ${
              state.danger
                ? "bg-accent-red text-white"
                : "bg-accent text-fg"
            } disabled:cursor-not-allowed disabled:opacity-35`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Portal anchor rect ---
// A position:fixed portal appended to <body> inherits the `html { zoom }` factor
// (index.html), so setting `top: T` renders it at `T * zoom`. getBoundingClientRect
// already returns coordinates in that same pre-zoom space, so we pass them straight
// through — dividing the zoom back out double-counts it and lands the portal ~1.2×
// too high (above its trigger).
export function portalAnchorRect(el: Element) {
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right: r.right,
    width: r.width,
    height: r.height,
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
  const isMobile = useMobileLayout();
  const base = "inline-flex items-center gap-1.5 font-mono font-bold uppercase tracking-wider border-2 border-fg cursor-pointer transition-all disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-neo-sm disabled:translate-x-0 disabled:translate-y-0";
  const sizes = isMobile
    ? (size === "xs" ? "min-h-11 px-3 py-2 text-[9px]" : "min-h-11 px-4 py-2 text-[10px]")
    : (size === "xs" ? "px-2 py-1 text-[9px]" : "px-3 py-1.5 text-[10px]");

  const variants = {
    default: "bg-bg-raised text-fg shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    primary: "bg-accent text-fg shadow-neo-sm hover:bg-accent-h hover:-translate-x-px hover:-translate-y-px hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    danger: "bg-accent-red text-white shadow-neo-sm hover:-translate-x-px hover:-translate-y-px hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
    ghost: "bg-bg-raised text-fg-dim shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none",
  };

  let renderedChildren: ReactNode = children;
  let iconReplaced = false;
  if (loading) {
    const swap = replaceFirstIconWithSpinner(children);
    renderedChildren = swap.found ? swap.node : stripLeadingGlyph(children);
    iconReplaced = swap.found;
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} title={title} className={`${base} ${sizes} ${variants[variant]} ${className}`}>
      {loading && !iconReplaced && <Loader2 size={size === "xs" ? 12 : 13} className="animate-spin flex-shrink-0" />}
      {renderedChildren}
    </button>
  );
}

// Text-only buttons often lead with a one-character glyph acting as the icon
// ("+ Add Passkey", "×"). While loading, that glyph is dropped so the prepended
// spinner takes its place instead of sitting next to it.
function stripLeadingGlyph(node: ReactNode): ReactNode {
  const arr = React.Children.toArray(node);
  const first = arr[0];
  if (typeof first === "string") {
    const m = first.match(/^\s*\S(\s+|$)/);
    if (m) return [first.slice(m[0].length), ...arr.slice(1)];
  }
  return node;
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
  const isMobile = useMobileLayout();

  if (isMobile) {
    return (
      <div className="space-y-3">
        {React.Children.toArray(children).map((row, rowIndex) => {
          if (!React.isValidElement(row)) return row;
          const cells = React.Children.toArray((row.props as { children?: ReactNode }).children);
          return (
            <div key={row.key ?? rowIndex} className="border-2 border-fg bg-bg-raised px-4 py-2 shadow-neo-sm">
              {cells.map((cell, cellIndex) => {
                if (!React.isValidElement(cell)) return null;
                const content = (cell.props as { children?: ReactNode }).children;
                const label = headers[cellIndex] || "";
                return (
                  <div key={cell.key ?? cellIndex} className={`flex min-h-10 items-center gap-3 border-b border-fg/10 py-2 last:border-b-0 ${label ? "justify-between" : "justify-end"}`}>
                    {label && <span className="shrink-0 font-mono text-[8px] font-bold uppercase tracking-wider text-muted">{label}</span>}
                    <div className="min-w-0 text-right font-mono text-[10px] text-fg">{content}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

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
export function Checkbox({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 group ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
      <span
        onClick={(e) => { e.preventDefault(); if (!disabled) onChange(!checked); }}
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
  const isMobile = useMobileLayout();
  const col = wide ? "w-[min(75%,34rem)]" : "w-[min(62%,20rem)]";
  if (isMobile) {
    return (
      <div className={`py-3 ${divider ? "border-b-2 border-fg/10 last:border-b-0" : ""} ${className}`}>
        {(label || hint) && (
          <div className="mb-2">
            {label && <label htmlFor={htmlFor} className="block font-mono text-[9px] font-bold uppercase tracking-wider text-fg">{label}</label>}
            {hint && <div className="mt-1 font-mono text-[9px] leading-snug text-muted">{hint}</div>}
          </div>
        )}
        <div className="w-full">{children}</div>
      </div>
    );
  }
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
