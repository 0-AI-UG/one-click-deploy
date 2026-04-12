import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm, EmptyState } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { Layers, Plus, Trash2, ChevronDown, ChevronRight, Key } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [expanded, setExpanded] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  };

  useEffect(load, []);

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
        await put(`/api/environments/${id}`, { name: editName, env_vars: vars });
        showToast("Environment updated", "success");
      }
      setExpanded(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  const renderEditor = (id: number | "new") => (
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
        <Btn size="xs" variant="primary" loading={loading} disabled={!editName.trim()} onClick={() => save(id)}>
          {id === "new" ? "Create" : "Save"}
        </Btn>
      </div>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Environments</h1>
        <Btn size="sm" variant="primary" onClick={startNew}>
          <Plus size={12} /> New
        </Btn>
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
                    </div>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Btn
                        size="xs"
                        variant="ghost"
                        title="Delete"
                        onClick={async () => {
                          if (await confirm("Delete Environment", `Delete "${env.name}"?`, true)) {
                            await del(`/api/environments/${env.id}`);
                            load();
                          }
                        }}
                      >
                        <Trash2 size={12} className="text-accent-red" />
                      </Btn>
                    </div>
                  </div>
                  {isOpen && renderEditor(env.id)}
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
