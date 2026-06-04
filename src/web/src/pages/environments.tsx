import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm, EmptyState } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { NeoSelect } from "../components/neo-select.tsx";
import { Layers, Plus, Trash2, Key, X } from "lucide-react";
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
      showToast("App attached — redeploying", "success");
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

  // Apps not yet attached to this environment
  const unattachedApps = (envId: number) => {
    const attached = new Set((attachedApps[envId] || []).map((a) => a.id));
    return allApps.filter((a) => !attached.has(a.id));
  };

  const renderEditor = (id: number | "new") => {
    const envBusy = typeof id === "number" && !!ops.byResourceKey(`env:${id}`);
    return (
      <Card className="p-4 space-y-3">
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
      </Card>
    );
  };

  const renderAttachedApps = (env: EnvironmentData) => {
    const apps = attachedApps[env.id] || [];
    const available = unattachedApps(env.id);
    return (
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Attached Apps</h3>
          {available.length > 0 && (
            <div className="w-40">
              <NeoSelect
                compact
                value=""
                placeholder="+ attach app"
                options={available.map((a) => ({ value: String(a.id), label: a.name }))}
                onChange={(v) => { if (v) attachApp(env.id, parseInt(v)); }}
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {apps.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1 font-mono text-[9px] px-2 py-1 bg-alt text-fg border-2 border-fg">
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
          {apps.length === 0 && (
            <span className="font-mono text-[9px] text-muted">no apps attached</span>
          )}
        </div>
      </Card>
    );
  };

  const selectedEnv = typeof expanded === "number" ? environments.find((e) => e.id === expanded) : undefined;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Environments</h1>
        <Btn size="sm" variant="primary" onClick={startNew}>
          <Plus size={12} /> New
        </Btn>
      </div>

      {environments.length > 0 || expanded === "new" ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          {/* Master list */}
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b-2 border-fg bg-alt">
              <span className="font-mono text-[10px] font-bold text-fg uppercase">Environments ({environments.length})</span>
            </div>
            <div className="divide-y divide-fg/10">
              {expanded === "new" && (
                <div className="px-4 py-3 flex items-center gap-2 bg-fg text-accent">
                  <Layers size={11} />
                  <span className="font-mono text-[10px] font-bold uppercase">New Environment</span>
                </div>
              )}
              {environments.map((env) => {
                const selected = expanded === env.id;
                const apps = attachedApps[env.id] || [];
                return (
                  <div
                    key={env.id}
                    onClick={() => toggle(env)}
                    className={`px-4 py-3 flex items-center justify-between cursor-pointer transition-colors ${selected ? "bg-fg text-accent" : "hover:bg-alt/50"}`}
                  >
                    <span className="font-mono text-[10px] font-bold uppercase truncate min-w-0">{env.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`font-mono text-[9px] flex items-center gap-1 ${selected ? "text-accent/70" : "text-muted"}`}>
                        <Key size={9} /> {env.env_vars.length}
                      </span>
                      {apps.length > 0 && (
                        <span className={`font-mono text-[9px] ${selected ? "text-accent/70" : "text-muted"}`}>
                          {apps.length} app{apps.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (apps.length > 0) {
                            showToast(`Cannot delete: used by ${apps.map((a) => a.name).join(", ")}`, "error");
                            return;
                          }
                          if (await confirm("Delete Environment", `Delete "${env.name}"?`, true)) {
                            try {
                              await del(`/api/environments/${env.id}`);
                              if (expanded === env.id) setExpanded(null);
                              load();
                            } catch (err: any) {
                              showToast(err.message || "Failed to delete", "error");
                            }
                          }
                        }}
                        className={`transition-colors ${selected ? "text-accent hover:text-white" : "text-muted hover:text-accent-red"}`}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Detail pane */}
          <div className="xl:col-span-2 space-y-6">
            {expanded === "new" ? (
              renderEditor("new")
            ) : selectedEnv ? (
              <>
                {renderAttachedApps(selectedEnv)}
                {renderEditor(selectedEnv.id)}
              </>
            ) : (
              <Card className="p-10">
                <p className="font-mono text-[10px] text-muted text-center uppercase tracking-wider">Select an environment to edit</p>
              </Card>
            )}
          </div>
        </div>
      ) : (
        <EmptyState message="No environments yet" icon={Layers} />
      )}
    </div>
  );
}
