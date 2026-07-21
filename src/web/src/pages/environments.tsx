import { useState, useEffect, useRef } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm, EmptyState } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { NeoSelect } from "../components/neo-select.tsx";
import { Layers, Plus, Trash2, Copy, ChevronDown, ChevronRight, Key, X } from "lucide-react";
import type { EnvironmentData, AppData } from "../types.ts";

type AttachedApp = { id: number; name: string; status: string; domain: string };

export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [expanded, setExpanded] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [attachedApps, setAttachedApps] = useState<Record<number, AttachedApp[]>>({});
  const [allApps, setAllApps] = useState<AppData[]>([]);
  // Inline "copy an environment" bar (source picker + new-name input), opened
  // from the header Copy button. null = closed.
  const [copy, setCopy] = useState<{ sourceId: number | null; name: string } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const copyPopoverRef = useRef<HTMLDivElement>(null);

  // Close the copy popover on an outside click — but ignore clicks in the
  // NeoSelect menu, which is portaled to document.body (outside the ref).
  useEffect(() => {
    if (!copy) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (copyPopoverRef.current && !copyPopoverRef.current.contains(target) && !target.closest("[data-neoselect-menu]")) {
        setCopy(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [copy]);

  const ops = useActiveOperations(
    (op) => op.kind === "cascade_redeploy",
    { rehydrateToasts: true },
  );

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
    get("/api/apps").then(setAllApps).catch(() => {});
  };

  useEffect(load, []);

  // Load attached apps for all environments
  useEffect(() => {
    for (const env of environments) {
      get(`/api/environments/${env.id}/apps`)
        .then((apps: AttachedApp[]) => {
          setAttachedApps((prev) => ({ ...prev, [env.id]: apps }));
        })
        .catch(() => {});
    }
  }, [environments]);

  const toggle = (env: EnvironmentData) => {
    if (expanded === env.id) {
      setExpanded(null);
    } else {
      setExpanded(env.id);
      setEditName(env.name);
      setEditVars(env.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret })));
    }
  };

  const startNew = () => {
    setExpanded("new");
    setEditName("");
    setEditVars([]);
  };

  const save = async (id: number | "new") => {
    setLoading(true);
    try {
      const vars = editVars.filter((e) => e.key.trim()).map((e) => ({
        key: e.key.trim(), value: e.value, secret: e.secret,
      }));
      if (id === "new") {
        await post("/api/environments", { name: editName, env_vars: vars });
        showToast("Environment created", "success");
      } else {
        const apps = attachedApps[id] || [];
        const activeApps = apps.filter((a) => a.status !== "stopped" && a.status !== "destroying");
        if (activeApps.length > 0) {
          const ok = await confirm(
            "Redeploy Apps",
            `Saving will redeploy ${activeApps.length} app(s): ${activeApps.map((a) => a.name).join(", ")}`,
            true,
          );
          if (!ok) { setLoading(false); return; }
        }
        const res = await put(`/api/environments/${id}`, { name: editName, env_vars: vars });
        const redeploying = res?.redeploying ?? 0;
        if (redeploying > 0 && res?.op_id) {
          trackOperationInToast(res.op_id, `Redeploying ${redeploying} app${redeploying !== 1 ? "s" : ""}`);
          ops.track(res.op_id);
        } else {
          showToast("Environment updated", "success");
        }
      }
      setExpanded(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  const attachApp = async (envId: number, appId: number) => {
    try {
      await post(`/api/environments/${envId}/apps`, { app_id: appId });
      showToast("App attached, redeploying", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to attach", "error");
    }
  };

  const detachApp = async (envId: number, appId: number) => {
    try {
      await post(`/api/environments/${envId}/apps/detach`, { app_id: appId });
      showToast("App detached", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to detach", "error");
    }
  };

  const startCopy = () => {
    setExpanded(null);
    const src = environments[0] ?? null;
    setCopy({ sourceId: src?.id ?? null, name: src ? `${src.name}-copy` : "" });
  };

  // When the source changes, pre-fill the name with "<source>-copy" unless the
  // user has already typed a custom name.
  const pickCopySource = (id: number | null) => {
    setCopy((c) => {
      if (!c) return c;
      const src = environments.find((e) => e.id === id);
      const prevSrc = environments.find((e) => e.id === c.sourceId);
      const untouched = c.name === "" || c.name === (prevSrc ? `${prevSrc.name}-copy` : "");
      return { sourceId: id, name: untouched && src ? `${src.name}-copy` : c.name };
    });
  };

  const doCopy = async () => {
    if (!copy?.sourceId || !copy.name.trim()) return;
    setCopyBusy(true);
    try {
      await post(`/api/environments/${copy.sourceId}/copy`, { name: copy.name.trim() });
      showToast("Environment duplicated", "success");
      setCopy(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to duplicate", "error");
    } finally {
      setCopyBusy(false);
    }
  };

  // Apps not yet attached to this environment
  const unattachedApps = (envId: number) => {
    const attached = new Set((attachedApps[envId] || []).map((a) => a.id));
    return allApps.filter((a) => !attached.has(a.id));
  };

  const renderEditor = (id: number | "new") => {
    const envBusy = typeof id === "number" && !!ops.byResourceKey(`env:${id}`);
    return (
      <div className="px-4 pb-3 pt-1 ml-7 space-y-3">
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Environment name"
          className="!text-[10px] font-bold uppercase"
          autoFocus
        />
        <EnvVarEditor entries={editVars} onChange={setEditVars} />
        <div className="flex gap-2 justify-end">
          <Btn size="xs" variant="ghost" onClick={() => setExpanded(null)}>Cancel</Btn>
          <Btn size="xs" variant="primary" loading={loading || envBusy} disabled={!editName.trim() || envBusy} onClick={() => save(id)}>
            {id === "new" ? "Create" : envBusy ? "Redeploying…" : "Save"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Environments</h1>
        <div className="flex items-center gap-2">
          {environments.length > 0 && (
            <div className="relative" ref={copyPopoverRef}>
              <Btn size="sm" variant="ghost" onClick={() => (copy ? setCopy(null) : startCopy())}>
                <Copy size={12} /> Copy
              </Btn>
              {copy && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-bg-raised border-2 border-fg shadow-neo p-3 space-y-2 w-56">
                  <NeoSelect
                    compact
                    value={copy.sourceId != null ? String(copy.sourceId) : ""}
                    placeholder="Environment to copy"
                    options={environments.map((e) => ({ value: String(e.id), label: e.name }))}
                    onChange={(v) => pickCopySource(v ? parseInt(v) : null)}
                  />
                  <input
                    type="text"
                    value={copy.name}
                    onChange={(e) => setCopy((c) => (c ? { ...c, name: e.target.value } : c))}
                    onKeyDown={(e) => { if (e.key === "Enter") doCopy(); if (e.key === "Escape") setCopy(null); }}
                    placeholder="New environment name"
                    className="w-full !text-[10px] font-bold uppercase"
                    autoFocus
                  />
                  <div className="flex gap-2 justify-end">
                    <Btn size="xs" variant="ghost" onClick={() => setCopy(null)}>Cancel</Btn>
                    <Btn size="xs" variant="primary" loading={copyBusy} disabled={!copy.sourceId || !copy.name.trim() || copyBusy} onClick={doCopy}>
                      Duplicate
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          <Btn size="sm" variant="primary" onClick={startNew}>
            <Plus size={12} /> New
          </Btn>
        </div>
      </div>

      {environments.length > 0 || expanded === "new" ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-fg/10">
            {expanded === "new" && (
              <div>
                <div className="px-4 py-3 flex items-center gap-3 bg-alt/30">
                  <ChevronDown size={12} className="text-muted flex-shrink-0" />
                  <span className="font-mono text-[10px] font-bold text-fg uppercase">New Environment</span>
                </div>
                {renderEditor("new")}
              </div>
            )}
            {environments.map((env) => {
              const isOpen = expanded === env.id;
              const apps = attachedApps[env.id] || [];
              const available = unattachedApps(env.id);
              return (
                <div key={env.id}>
                  <div
                    className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors cursor-pointer"
                    onClick={() => toggle(env)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isOpen
                        ? <ChevronDown size={12} className="text-muted flex-shrink-0" />
                        : <ChevronRight size={12} className="text-muted flex-shrink-0" />
                      }
                      <span className="font-mono text-[10px] font-bold text-fg uppercase">{env.name}</span>
                      <span className="font-mono text-[9px] text-muted flex items-center gap-1">
                        <Key size={9} /> {env.env_vars.length}
                      </span>
                      {apps.length > 0 && (
                        <span className="font-mono text-[9px] text-muted">
                          {apps.length} app{apps.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Btn
                        size="xs"
                        variant="ghost"
                        title="Delete"
                        onClick={async () => {
                          if (apps.length > 0) {
                            showToast(`Cannot delete: used by ${apps.map((a) => a.name).join(", ")}`, "error");
                            return;
                          }
                          if (await confirm("Delete Environment", `Delete "${env.name}"?`, true)) {
                            try {
                              await del(`/api/environments/${env.id}`);
                              load();
                            } catch (err: any) {
                              showToast(err.message || "Failed to delete", "error");
                            }
                          }
                        }}
                      >
                        <Trash2 size={12} className="text-accent-red" />
                      </Btn>
                    </div>
                  </div>
                  {isOpen && (
                    <>
                      {/* Attached apps with detach */}
                      <div className="px-4 py-2 ml-7 flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[9px] text-muted uppercase">Apps:</span>
                        {apps.map((a) => (
                          <span key={a.id} className="inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 bg-alt text-fg">
                            <a href={`#/apps/${a.id}`} className="hover:underline">{a.name}</a>
                            <button
                              onClick={() => detachApp(env.id, a.id)}
                              className="text-muted hover:text-accent-red transition-colors"
                              title="Detach"
                            >
                              <X size={9} />
                            </button>
                          </span>
                        ))}
                        {available.length > 0 && (
                          <div className="w-32">
                            <NeoSelect
                              compact
                              value=""
                              placeholder="+ attach app"
                              options={available.map((a) => ({ value: String(a.id), label: a.name }))}
                              onChange={(v) => { if (v) attachApp(env.id, parseInt(v)); }}
                            />
                          </div>
                        )}
                        {apps.length === 0 && available.length === 0 && (
                          <span className="font-mono text-[9px] text-muted">no apps</span>
                        )}
                      </div>
                      {renderEditor(env.id)}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <EmptyState message="No environments yet" icon={Layers} />
      )}
    </div>
  );
}
