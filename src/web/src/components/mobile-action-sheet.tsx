import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export function MobileActionSheet({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[85] flex items-end" role="presentation">
      <button
        aria-label="Close actions"
        className="absolute inset-0 bg-fg/45 animate-fade-in"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-h-[82dvh] overflow-y-auto rounded-t-[22px] border-2 border-b-0 border-fg bg-bg-raised px-4 pt-3 pb-[calc(18px+env(safe-area-inset-bottom))] shadow-[0_-5px_0_#1A1A1A] animate-slide-up"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-fg/25" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-bold uppercase text-fg">{title}</h2>
            {subtitle && <p className="mt-1 truncate font-mono text-[10px] text-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg active:bg-alt"
          >
            <X size={20} />
          </button>
        </div>
        <div className="space-y-2">{children}</div>
      </section>
    </div>
  );
}

export function MobileSheetAction({
  icon,
  label,
  detail,
  danger = false,
  primary = false,
  disabled = false,
  loading = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex min-h-14 w-full items-center gap-3 border-2 border-fg px-4 py-3 text-left font-mono shadow-neo-sm transition-transform active:translate-x-0.5 active:translate-y-0.5 active:shadow-none disabled:opacity-40 ${
        danger ? "bg-accent-red text-white" : primary ? "bg-accent text-fg" : "bg-bg-raised text-fg"
      }`}
    >
      <span className={loading ? "animate-spin" : ""}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-bold uppercase tracking-wide">{loading ? `${label}…` : label}</span>
        {detail && <span className={`mt-0.5 block text-[9px] normal-case ${danger ? "text-white/75" : "text-muted"}`}>{detail}</span>}
      </span>
    </button>
  );
}
