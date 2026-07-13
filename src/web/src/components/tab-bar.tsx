export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { key: K; label: string }[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex border-b-2 border-fg mb-4">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
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
