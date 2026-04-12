import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm, EmptyState } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { Layers, Plus, Trash2, Pencil, ChevronDown, ChevronRight, Key } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  };

  useEffect(load, []);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const startEdit = (env: EnvironmentData) => {
    setEditing(env.id);
    setEditName(env.name);
    setEditVars(env.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret })));
  };

  const startNew = () => {
    setEditing("new");
    setEditName("");
    setEditVars([]);
  };

  const save = async () => {
    setLoading(true);
    try {
      const vars = editVars.filter((e) => e.key.trim()).map((e) => ({
        key: e.key.trim(), value: e.value, secret: e.secret,
      }));
      if (editing === "new") {
        await post("/api/environments", { name: editName, env_vars: vars });
        showToast("Environment created", "success");
      } else {
        await put(`/api/environments/${editing}`, { name: editName, env_vars: vars });
        showToast("Environment updated", "success");
      }
      setEditing(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Environments</h1>
        <Btn size="sm" variant="primary" onClick={startNew}>
          <Plus size={12} /> New
        </Btn>
      </div>

      {/* Inline create/edit form */}
      {editing !== null && (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b-2 border-fg bg-alt flex items-center gap-2">
            <Layers size={14} className="text-fg" />
            <span className="font-mono text-[10px] font-bold text-fg uppercase">
              {editing === "new" ? "New Environment" : "Edit Environment"}
            </span>
          </div>
          <div className="p-4 space-y-3">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Environment name"
              className="w-full"
              autoFocus
            />
            <EnvVarEditor entries={editVars} onChange={setEditVars} />
            <div className="flex gap-2 justify-end pt-1">
              <Btn size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
              <Btn size="sm" variant="primary" loading={loading} disabled={!editName.trim()} onClick={save}>
                {editing === "new" ? "Create" : "Save"}
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {/* Environment list */}
      {environments.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-fg/10">
            {environments.map((env) => {
              const isExpanded = expanded.has(env.id);
              return (
                <div key={env.id}>
                  <div
                    className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors cursor-pointer"
                    onClick={() => toggleExpand(env.id)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isExpanded
                        ? <ChevronDown size={12} className="text-muted flex-shrink-0" />
                        : <ChevronRight size={12} className="text-muted flex-shrink-0" />
                      }
                      <span className="font-mono text-[10px] font-bold text-fg uppercase">{env.name}</span>
                      <span className="font-mono text-[9px] text-muted flex items-center gap-1">
                        <Key size={9} />
                        {env.env_vars.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Btn size="xs" variant="ghost" onClick={() => startEdit(env)} title="Edit">
                        <Pencil size={12} />
                      </Btn>
                      <Btn
                        size="xs"
                        variant="ghost"
                        title="Delete"
                        onClick={async () => {
                          if (await confirm("Delete Environment", `Delete "${env.name}"? Apps using it will be unassigned.`, true)) {
                            await del(`/api/environments/${env.id}`);
                            load();
                          }
                        }}
                      >
                        <Trash2 size={12} className="text-accent-red" />
                      </Btn>
                    </div>
                  </div>
                  {isExpanded && env.env_vars.length > 0 && (
                    <div className="px-4 pb-3 pt-0 ml-7">
                      <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[10px] font-mono">
                        {env.env_vars.map((e) => (
                          <div key={e.key} className="contents">
                            <span className="text-accent-blue font-bold">{e.key}</span>
                            <span className="text-fg-dim truncate">{e.secret ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : e.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : editing === null ? (
        <EmptyState message="No environments yet" icon={Layers} />
      ) : null}
    </div>
  );
}
