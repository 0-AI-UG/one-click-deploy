import { useState, useEffect } from "react";
import { get, patch } from "../../api/client.ts";
import { Btn, Field, showToast } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { InfoTip } from "./shared.tsx";
import { Layers, Check, X } from "lucide-react";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// A pool name is a lowercase slug, ≤32 chars — mirrors the backend validation on
// PATCH /api/apps/:id/pool. Sentinel select value that reveals the "new pool"
// text input instead of switching pools.
const POOL_SLUG = /^[a-z][a-z0-9-]*$/;
const NEW_POOL = " new-pool";

interface PlacementPoolFieldProps {
  appId: number;
  // servers.pool this app's replicas schedule onto ("general" = default).
  placementPool?: string;
}

// Retrospective placement-pool control — pick a known pool or type a new one.
// A settings Field (lives inline in the app-basics card); saves instantly on
// change via its own PATCH, gated on apps.deploy.
export function PlacementPoolField({ appId, placementPool }: PlacementPoolFieldProps) {
  // Kept in local state so the UI reflects a change without a parent refetch.
  const [currentPool, setCurrentPool] = useState<string>(placementPool ?? "general");
  const [poolOptions, setPoolOptions] = useState<string[]>(["general", "staging"]);
  const [poolSaving, setPoolSaving] = useState(false);
  const [newPoolMode, setNewPoolMode] = useState(false);
  const [newPoolValue, setNewPoolValue] = useState("");
  const [newPoolErr, setNewPoolErr] = useState<string | null>(null);

  useEffect(() => { setCurrentPool(placementPool ?? "general"); }, [appId, placementPool]);

  useEffect(() => {
    // Non-fatal: keep the two hardcoded fallbacks if the pool list can't load.
    get("/api/pools")
      .then((res) => {
        if (Array.isArray(res?.pools) && res.pools.length) setPoolOptions(res.pools);
      })
      .catch(() => { /* keep fallback */ });
  }, [appId]);

  const changePool = async (next: string) => {
    if (next === currentPool) return;
    const prev = currentPool;
    setCurrentPool(next);
    setPoolSaving(true);
    try {
      await patch(`/api/apps/${appId}/pool`, { pool: next });
      showToast(`Placement pool set to "${next}"`, "success");
    } catch (err) {
      setCurrentPool(prev);
      showToast(errMessage(err), "error");
    } finally {
      setPoolSaving(false);
    }
  };

  const onPoolSelect = (v: string) => {
    if (v === NEW_POOL) {
      setNewPoolValue("");
      setNewPoolErr(null);
      setNewPoolMode(true);
      return;
    }
    changePool(v);
  };

  const confirmNewPool = () => {
    const slug = newPoolValue.trim().toLowerCase();
    if (!POOL_SLUG.test(slug) || slug.length > 32) {
      setNewPoolErr("Pool must be a lowercase slug, ≤32 chars");
      return;
    }
    setNewPoolMode(false);
    changePool(slug);
  };

  return (
    <Field
      align="start"
      label={<span className="flex items-center gap-2"><Layers size={14} className="text-fg" /> Placement Pool <InfoTip text="Replicas schedule onto servers in this pool. Changing it reschedules replicas on the next reconcile." /></span>}
      hint={<>Replicas schedule onto the <span className="font-mono font-bold text-fg">{currentPool}</span> pool. Saved immediately; applied on the next reconcile.</>}
    >
        <PermissionGate
          permission="apps.deploy"
          fallback={
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5 bg-alt text-fg inline-flex items-center gap-1">
              <Layers size={10} /> {currentPool}
            </span>
          }
        >
          {newPoolMode ? (
            <div className="relative flex items-center gap-2">
              <input
                value={newPoolValue}
                onChange={(e) => { setNewPoolValue(e.target.value); setNewPoolErr(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmNewPool();
                  if (e.key === "Escape") setNewPoolMode(false);
                }}
                placeholder="pool-name"
                autoFocus
                className="flex-1 min-w-0 bg-bg border-2 border-fg px-2 py-1.5 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-accent"
              />
              <Btn variant="primary" disabled={poolSaving} onClick={confirmNewPool}>
                <Check size={13} /> Set
              </Btn>
              <Btn variant="ghost" onClick={() => setNewPoolMode(false)}>
                <X size={13} />
              </Btn>
              {newPoolErr && (
                <span className="absolute top-full left-0 mt-1 font-mono text-[9px] font-bold uppercase text-accent-red">
                  {newPoolErr}
                </span>
              )}
            </div>
          ) : (
            <NeoSelect
              value={currentPool}
              disabled={poolSaving}
              onChange={onPoolSelect}
              options={[
                ...Array.from(new Set([...poolOptions, currentPool])).sort().map((p) => ({ value: p, label: p })),
                { value: NEW_POOL, label: "+ New pool…" },
              ]}
            />
          )}
        </PermissionGate>
    </Field>
  );
}
