import React, { useState, useEffect, useCallback, useId, type ReactNode } from "react";
import { X, AlertTriangle, Loader2, Copy, Check, Info, ArrowLeft } from "lucide-react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
export { portalAnchorRect } from "./portal-position.ts";

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
    <div aria-live="polite" aria-relevant="additions text" className={isMobile ? "pointer-events-none fixed inset-x-3 top-[calc(62px+env(safe-area-inset-top))] z-[100] flex flex-col gap-2" : "fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"}>
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

  useEffect(() => {
    if (!state.open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [state.open]);

  if (!state.open) return null;

  const close = (v: boolean) => {
    state.resolve?.(v);
    confirmState = { open: false, title: "", message: "" };
    notifyConfirmListeners();
  };

  return (
    <div className={`fixed inset-0 z-[90] flex bg-fg/40 animate-fade-in ${isMobile ? "items-end" : "items-center justify-center"}`}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" className={isMobile ? "w-full rounded-t-[22px] border-2 border-b-0 border-fg bg-bg-raised px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 shadow-[0_-5px_0_#1A1A1A] animate-slide-up" : "bg-bg-raised border-2 border-fg shadow-neo p-6 max-w-md w-full mx-4 animate-slide-up"}>
        {isMobile && <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-fg/25" />}
        <div className="flex items-start gap-3 mb-4">
          {state.danger && <AlertTriangle size={20} className="text-accent-red mt-0.5 flex-shrink-0" />}
          <div>
            <h3 id="confirm-dialog-title" className="font-mono font-bold text-sm text-fg uppercase">{state.title}</h3>
            <p id="confirm-dialog-message" className="text-xs text-fg-dim mt-1">{state.message}</p>
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

// --- Spinner ---
export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 size={16} className={`animate-spin text-fg ${className}`} />;
}

// --- Copy Button ---
export function CopyButton({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="p-1 text-muted hover:text-fg transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={size} className="text-fg" /> : <Copy size={size} />}
    </button>
  );
}

// --- Info tip ---
// Help is deliberately hidden until requested, but remains available through
// hover, keyboard focus, and tap. Keeping this here gives every form the same
// interaction and avoids permanently rendering explanatory paragraphs.
export function InfoTip({ children, text }: { children?: ReactNode; text?: ReactNode }) {
  const content = children ?? text;
  const tooltipId = useId();
  if (!content) return null;

  return (
    <span className="group relative inline-flex shrink-0 items-center">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={tooltipId}
        className="inline-grid h-5 w-5 place-items-center text-muted transition-colors hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Info size={12} aria-hidden="true" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-[80] mb-1.5 w-max max-w-[260px] -translate-x-1/2 border-2 border-fg bg-bg px-2.5 py-2 font-mono text-[9px] font-normal normal-case leading-relaxed tracking-normal text-fg opacity-0 shadow-neo-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}

// --- Status Badge ---
export function StatusBadge({ status, subLabel }: { status: string; subLabel?: string }) {
  const s = status?.toLowerCase() || "unknown";
  const dotColor =
    ["running", "done", "ready", "online", "healthy", "active", "deployed", "completed", "open"].includes(s) ? "bg-accent" :
    ["deploying", "waking", "sleeping", "pending", "queued", "compensating", "connecting", "disconnected", "ended"].includes(s) ? "bg-accent-amber" :
    s === "paused" ? "bg-alt" :
    ["unhealthy", "error", "failed", "offline", "cancelled", "compensation_failed"].includes(s) ? "bg-accent-red" :
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

// --- Page composition ---
// The panel used to rebuild its page container and title row in every route.
// These primitives keep spacing, hierarchy, back navigation, and responsive
// action placement consistent without prescribing page-specific content.
export function PageShell({
  children,
  width = "lg",
  className = "",
}: {
  children: ReactNode;
  width?: "md" | "lg" | "xl";
  className?: string;
}) {
  const widths = { md: "max-w-3xl", lg: "max-w-4xl", xl: "max-w-6xl" };
  return (
    <main className={`${widths[width]} mx-auto space-y-5 px-4 py-5 md:py-6 animate-fade-in ${className}`}>
      {children}
    </main>
  );
}

export function PageHeader({
  title,
  eyebrow,
  description,
  meta,
  backHref,
  backLabel = "Back",
  actions,
  className = "",
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="flex min-w-0 items-start gap-3">
        {backHref && (
          <a
            href={backHref}
            aria-label={backLabel}
            title={backLabel}
            className="grid h-9 w-9 shrink-0 place-items-center border-2 border-fg bg-bg-raised text-fg shadow-neo-sm transition-all hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
          >
            <ArrowLeft size={16} />
          </a>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-muted">{eyebrow}</div>}
          <h1 className="truncate font-mono text-lg font-bold uppercase leading-tight tracking-wide text-fg">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-dim">{description}</p>}
          {meta && <div className="mt-1.5 font-mono text-[9px] text-muted">{meta}</div>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-wider text-fg">{title}</h2>
        {description && <p className="mt-1 text-[10px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

export function PageState({
  kind = "loading",
  title,
  description,
  action,
}: {
  kind?: "loading" | "empty" | "error";
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <PageShell>
      <div role={kind === "error" ? "alert" : "status"} className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
        {kind === "loading" && <Spinner />}
        {title && <div className={`font-mono text-xs font-bold uppercase tracking-wider ${kind === "error" ? "text-accent-red" : "text-fg"}`}>{title}</div>}
        {description && <p className="max-w-md text-xs leading-relaxed text-muted">{description}</p>}
        {action}
      </div>
    </PageShell>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  className?: string;
}) {
  const tones = {
    neutral: "bg-alt text-fg-dim",
    success: "bg-accent text-fg",
    warning: "bg-accent-amber text-fg",
    danger: "bg-accent-red text-white",
    info: "bg-accent-blue text-white",
  };
  return <span className={`inline-flex items-center gap-1 border-2 border-fg px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider shadow-neo-sm ${tones[tone]} ${className}`}>{children}</span>;
}

export function InlineNotice({
  children,
  tone = "info",
  title,
  className = "",
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-accent-blue bg-accent-blue/10",
    success: "border-fg bg-accent/20",
    warning: "border-accent-amber bg-accent-amber/15",
    danger: "border-accent-red bg-accent-red/10",
  };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`border-2 p-3 ${tones[tone]} ${className}`}>
      {title && <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg">{title}</div>}
      <div className="text-[10px] leading-relaxed text-fg-dim">{children}</div>
    </div>
  );
}

export function AuthShell({
  icon,
  title,
  description,
  children,
  width = "sm",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  width?: "sm" | "md" | "lg";
}) {
  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" };
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className={`w-full ${widths[width]} animate-slide-up`}>
        <header className="mb-6 text-center">
          {icon && <div className="mb-3 flex justify-center text-fg">{icon}</div>}
          <h1 className="font-mono text-lg font-bold uppercase tracking-wider text-fg">{title}</h1>
          {description && <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">{description}</p>}
        </header>
        {children}
      </div>
    </main>
  );
}

// --- Card ---
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
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
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const isMobile = useMobileLayout();
  const base = "inline-flex items-center gap-1.5 font-mono font-bold uppercase tracking-wider border-2 border-fg cursor-pointer transition-all disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-neo-sm disabled:translate-x-0 disabled:translate-y-0";
  const sizes = isMobile
    ? (size === "xs" ? "min-h-11 px-3 py-2 text-[9px]" : size === "md" ? "min-h-12 px-5 py-3 text-[11px]" : "min-h-11 px-4 py-2 text-[10px]")
    : (size === "xs" ? "px-2 py-1 text-[9px]" : size === "md" ? "px-4 py-2.5 text-[10px]" : "px-3 py-1.5 text-[10px]");

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
    <button type={type} onClick={onClick} disabled={disabled || loading} title={title} aria-label={ariaLabel || title} className={`${base} ${sizes} ${variants[variant]} ${className}`}>
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
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label || "Toggle option"}
        onChange={(event) => onChange(event.target.checked)}
        className="shrink-0"
      />
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
  const generatedId = useId();
  const isNativeControl = React.isValidElement(children)
    && typeof children.type === "string"
    && ["input", "select", "textarea"].includes(children.type);
  const controlId = htmlFor || (isNativeControl ? generatedId : undefined);
  const renderedControl = isNativeControl
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id: (children.props as { id?: string }).id || controlId,
      })
    : children;
  const col = wide ? "w-[min(75%,34rem)]" : "w-[min(62%,20rem)]";
  const fieldLabel = label || hint ? (
    <div className="flex min-w-0 items-center gap-1">
      {label && <label htmlFor={controlId} className="block font-mono text-[9px] font-bold uppercase leading-tight tracking-wider text-fg">{label}</label>}
      {hint && <InfoTip>{hint}</InfoTip>}
    </div>
  ) : null;
  if (isMobile) {
    return (
      <div className={`py-3 ${divider ? "border-b-2 border-fg/10 last:border-b-0" : ""} ${className}`}>
        {fieldLabel && <div className="mb-2">{fieldLabel}</div>}
        <div className="w-full">{renderedControl}</div>
      </div>
    );
  }
  return (
    <div
      className={`flex ${align === "start" ? "items-start" : "items-center"} justify-between gap-4 py-3 ${
        divider ? "border-b-2 border-fg/10 last:border-b-0" : ""
      } ${className}`}
    >
      {fieldLabel && <div className={`min-w-0 ${align === "start" ? "pt-1.5" : ""}`}>{fieldLabel}</div>}
      <div className={`shrink-0 ${col}`}>{renderedControl}</div>
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
