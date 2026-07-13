import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { X, Loader2, Database } from "lucide-react";
import type { CatalogEntry } from "./types.ts";

function groupByCategory(entries: CatalogEntry[]): [string, CatalogEntry[]][] {
  const buckets = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const key = e.category || "other";
    const list = buckets.get(key) || [];
    list.push(e);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return Array.from(buckets.entries()).sort(([a], [b]) => {
    if (a === "other") return 1;
    if (b === "other") return -1;
    return a.localeCompare(b);
  });
}

export function ServicesGridSection({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    get("/api/services/catalog")
      .then((data: CatalogEntry[]) => {
        setCatalog(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  return (
    <div className="border-2 border-fg bg-bg animate-fade-in">
      <div className="px-4 py-2 border-b-2 border-fg bg-alt flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={12} className="text-fg" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-fg">Deploy a service</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-dim hover:text-fg transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="p-4">
        {!loaded ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-fg-dim" />
          </div>
        ) : catalog.length === 0 ? (
          <div className="font-mono text-[10px] text-fg-dim text-center py-6">No services available</div>
        ) : (
          <div className="space-y-5">
            {groupByCategory(catalog).map(([category, entries]) => (
              <div key={category}>
                <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim mb-2">
                  {category}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {entries.map((entry) => (
                    <a
                      key={entry.type}
                      href={`#/deploy-service/${entry.type}`}
                      className="flex items-start gap-2 border-2 border-fg/20 hover:border-fg bg-bg hover:bg-alt p-2.5 transition-colors"
                    >
                      <div className={`w-7 h-7 ${entry.color || "bg-gray-500"} flex items-center justify-center text-white font-mono text-[9px] font-bold shrink-0`}>
                        {entry.icon || entry.label.slice(0, 2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] font-bold text-fg uppercase truncate">{entry.label}</div>
                        {entry.description && (
                          <div className="font-mono text-[9px] text-fg-dim mt-0.5 line-clamp-2">{entry.description}</div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
