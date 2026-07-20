import { useState, useEffect } from "react";
import { get, post, patch } from "../../api/client.ts";
import { Card, Btn, StatusBadge, Table, Spinner, EmptyState, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import { GitBranch, ArrowUpCircle, Plus, Rocket, X, Layers, Check } from "lucide-react";
import type { AppTargetsResponse } from "../../../../shared/rpc.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// A pool name is a lowercase slug, ≤32 chars — mirrors the backend validation on
// PATCH /api/apps/:id/pool. Sentinel select value that reveals the "new pool"
// text input instead of switching pools.
const POOL_SLUG = /^[a-z][a-z0-9-]*$/;
const NEW_POOL = " new-pool";

interface TargetsTabProps {
  // The full AppData object is passed from AppDetailPage; placement_pool is the
  // pool this app's replicas schedule onto ("general" = default).
  app: { id: number; name: string; placement_pool?: string };
  // Shared op-runner from AppDetailPage: tracks op_id in a toast + ops store
  // (identical to how rollback is surfaced from the Deployments tab).
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

const badgeClass = "font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5 bg-alt text-fg";

export function TargetsTab({ app, action, ops }: TargetsTabProps) {
  const [data, setData] = useState<AppTargetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Retrospective target setup: inline form to spin up a `<name>-<target>`
  // isolated sibling straight from this tab (reuses the parent's build config).
  const [adding, setAdding] = useState(false);
  const [targetName, setTargetName] = useState("staging");
  const [creating, setCreating] = useState(false);
  // Retrospective re-pool: current placement pool sourced from the app prop,
  // kept in local state so the UI reflects a change without a parent refetch.
  const [currentPool, setCurrentPool] = useState<string>(app.placement_pool ?? "general");
  const [poolOptions, setPoolOptions] = useState<string[]>(["general", "staging"]);
  const [poolSaving, setPoolSaving] = useState(false);
  const [newPoolMode, setNewPoolMode] = useState(false);
  const [newPoolValue, setNewPoolValue] = useState("");
  const [newPoolErr, setNewPoolErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setData(await get(`/api/apps/${app.id}/targets`));
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
    // Non-fatal: keep the two hardcoded fallbacks if the pool list can't load.
    try {
      const res = await get("/api/pools");
      if (Array.isArray(res?.pools) && res.pools.length) setPoolOptions(res.pools);
    } catch {
      /* keep fallback */
    }
  };

  useEffect(() => { load(); }, [app.id]);
  useEffect(() => { setCurrentPool(app.placement_pool ?? "general"); }, [app.id, app.placement_pool]);

  const changePool = async (next: string) => {
    if (next === currentPool) return;
    const prev = currentPool;
    setCurrentPool(next);
    setPoolSaving(true);
    try {
      await patch(`/api/apps/${app.id}/pool`, { pool: next });
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

  const promote = async (sourceName: string, destName: string) => {
    if (await confirm(
      "Promote to Production",
      `Promote ${sourceName} to ${destName}? This rebuilds production at the commit currently running in ${sourceName}.`,
    )) {
      await action("promote", () => post("/api/apps/promote", { source_app: sourceName, dest_app: destName }));
      load();
    }
  };

  // Kick off an isolated deploy for the new target and jump to its live progress
  // (same destination the Deploy page uses), so the user watches it come up.
  const createTarget = async () => {
    const name = targetName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      showToast("Target must be a lowercase slug (e.g. staging or dev)", "error");
      return;
    }
    setCreating(true);
    try {
      const res = (await post(`/api/apps/${app.id}/targets`, { target: name })) as { op_id: number };
      if (!res.op_id) throw new Error("No op_id returned");
      window.location.hash = `#/deploy/progress/${res.op_id}`;
    } catch (err) {
      showToast(errMessage(err), "error");
      setCreating(false);
    }
  };

  if (loading || !data) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  const { self, targets } = data;
  const isSibling = self.target !== "" && self.target !== "production";

  // Retrospective placement-pool control — pick a known pool or type a new one.
  // Gated on apps.deploy to match this tab's other mutations.
  const poolCard = (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Placement Pool</h3>
      </div>
      <p className="text-[11px] text-fg-dim mb-3 leading-snug">
        Replicas of this app schedule onto servers in the{" "}
        <span className="font-mono font-bold text-fg">{currentPool}</span> pool. Changing it
        reschedules replicas on the next reconcile.
      </p>
      <PermissionGate
        permission="apps.deploy"
        fallback={
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5 bg-alt text-fg inline-flex items-center gap-1">
            <Layers size={10} /> {currentPool}
          </span>
        }
      >
        {newPoolMode ? (
          <div className="relative flex items-center gap-2 max-w-xs">
            <input
              value={newPoolValue}
              onChange={(e) => { setNewPoolValue(e.target.value); setNewPoolErr(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmNewPool();
                if (e.key === "Escape") setNewPoolMode(false);
              }}
              placeholder="pool-name"
              autoFocus
              className="flex-1 bg-bg border-2 border-fg px-2 py-1.5 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-accent"
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
          <div className="w-48">
            <NeoSelect
              value={currentPool}
              disabled={poolSaving}
              onChange={onPoolSelect}
              options={[
                ...Array.from(new Set([...poolOptions, currentPool])).sort().map((p) => ({ value: p, label: p })),
                { value: NEW_POOL, label: "+ New pool…" },
              ]}
            />
          </div>
        )}
      </PermissionGate>
    </Card>
  );

  // This app IS a target sibling (e.g. "<base>-staging"): offer promotion of
  // itself up to its production parent. The parent resolved from target_of is
  // authoritative; the name-suffix strip is only a fallback for legacy rows
  // without the link — and only when it actually yields a different name.
  if (isSibling) {
    const suffix = `-${self.target}`;
    const stripped = self.name.endsWith(suffix) ? self.name.slice(0, -suffix.length) : self.name;
    const destName = self.parent?.name ?? (stripped !== self.name ? stripped : null);
    return (
      <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deploy Target</h3>
        </div>
        <p className="text-xs text-fg-dim mb-4">
          This is the <span className="font-mono font-bold text-fg">{self.target}</span> target
          {destName ? (
            <> of <span className="font-mono font-bold text-fg">{destName}</span>.</>
          ) : (
            <> (no production parent found to promote to).</>
          )}
        </p>
        {destName && (
          <PermissionGate permission="apps.deploy">
            <Btn
              variant="primary"
              disabled={ops.isBusy}
              loading={ops.isBusyWith("promote")}
              onClick={() => promote(self.name, destName)}
            >
              <ArrowUpCircle size={13} /> Promote to Production
            </Btn>
          </PermissionGate>
        )}
      </Card>
      {poolCard}
      </div>
    );
  }

  // Inline "set up a target" form — an isolated `<name>-<target>` sibling built
  // from this app's config. Shared by the empty state and the header + button.
  const addForm = (
    <div className="border-2 border-fg bg-alt/40 p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Plus size={12} className="text-fg" />
        <span className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Set up a target</span>
        <button
          type="button"
          onClick={() => setAdding(false)}
          className="ml-auto text-fg-dim hover:text-fg transition-colors"
          title="Cancel"
        >
          <X size={13} />
        </button>
      </div>
      <p className="text-[11px] text-fg-dim mb-3 leading-snug">
        Deploys an isolated <span className="font-mono font-bold text-fg">{self.name}-{targetName.trim().toLowerCase() || "…"}</span> sibling
        from this app's build config, with its own environment seeded from production.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={targetName}
          onChange={(e) => setTargetName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !creating) createTarget(); }}
          placeholder="staging"
          autoFocus
          className="flex-1 bg-bg border-2 border-fg px-2 py-1.5 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-accent"
        />
        <PermissionGate permission="apps.deploy">
          <Btn variant="primary" disabled={creating} loading={creating} onClick={createTarget}>
            <Rocket size={13} /> Deploy target
          </Btn>
        </PermissionGate>
      </div>
    </div>
  );

  // This app is a base/production app: list its staging/dev siblings, each
  // promotable back up to this app.
  return (
    <div className="space-y-4">
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <GitBranch size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deploy Targets</h3>
        {targets.length > 0 && !adding && (
          <PermissionGate permission="apps.deploy">
            <Btn size="xs" className="ml-auto" onClick={() => setAdding(true)}>
              <Plus size={12} /> Add target
            </Btn>
          </PermissionGate>
        )}
      </div>
      {adding && addForm}
      {targets.length === 0 ? (
        adding ? null : (
          <div className="flex flex-col items-center">
            <EmptyState
              icon={GitBranch}
              message="No targets yet — set one up, or run ocd deploy --target=staging"
            />
            <PermissionGate permission="apps.deploy">
              <Btn variant="primary" className="-mt-6 mb-4" onClick={() => setAdding(true)}>
                <Plus size={13} /> Add target
              </Btn>
            </PermissionGate>
          </div>
        )
      ) : (
        <Table headers={["Name", "Target", "Status", "Domain", ""]}>
          {targets.map((t) => (
            <tr key={t.id} className="hover:bg-alt/50">
              <td className="py-2 px-3 text-fg font-bold">{t.name}</td>
              <td className="py-2 px-3"><span className={badgeClass}>{t.target}</span></td>
              <td className="py-2 px-3"><StatusBadge status={t.status} /></td>
              <td className="py-2 px-3 text-fg-dim">
                {t.domain
                  ? <a href={`https://${t.domain}`} target="_blank" rel="noreferrer" className="hover:text-fg underline">{t.domain}</a>
                  : <span className="text-muted">—</span>}
              </td>
              <td className="py-2 px-3">
                <PermissionGate permission="apps.deploy">
                  <Btn
                    size="xs" variant="ghost"
                    disabled={ops.isBusy}
                    loading={ops.isBusyWith("promote")}
                    onClick={() => promote(t.name, self.name)}
                  >
                    <ArrowUpCircle size={12} /> Promote → production
                  </Btn>
                </PermissionGate>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
    {poolCard}
    </div>
  );
}
