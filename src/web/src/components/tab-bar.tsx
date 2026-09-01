import { useEffect, useRef } from "react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";

export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { key: K; label: string }[];
  active: K;
  onChange: (key: K) => void;
}) {
  const isMobile = useMobileLayout();
  const activeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const currentIndex = tabs.findIndex((tab) => tab.key === active);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    onChange(tabs[nextIndex].key);
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[nextIndex]?.focus();
    });
  };

  useEffect(() => {
    if (isMobile) activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [active, isMobile]);

  if (isMobile) {
    return (
      <div className="sticky top-[52px] z-30 -mx-4 mb-4 border-y-2 border-fg bg-bg/95 px-3 py-2 backdrop-blur">
        <div ref={listRef} onKeyDown={onKeyDown} className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Page sections">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              ref={active === tab.key ? activeRef : undefined}
              onClick={() => onChange(tab.key)}
              role="tab"
              aria-selected={active === tab.key}
              tabIndex={active === tab.key ? 0 : -1}
              className={`min-h-10 shrink-0 border-2 border-fg px-4 font-mono text-[10px] font-bold uppercase tracking-wide shadow-neo-sm ${
                active === tab.key ? "bg-accent text-fg" : "bg-bg-raised text-muted"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={listRef} onKeyDown={onKeyDown} className="flex border-b-2 border-fg mb-4" role="tablist" aria-label="Page sections">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          role="tab"
          aria-selected={active === t.key}
          tabIndex={active === t.key ? 0 : -1}
          className={`px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-wider border-b-2 -mb-[2px] transition-all ${
            active === t.key
              ? "border-fg text-fg bg-accent"
              : "border-transparent text-muted hover:text-fg"
          }`}
        >{t.label}</button>
      ))}
    </div>
  );
}
