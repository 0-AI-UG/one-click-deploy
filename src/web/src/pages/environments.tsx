import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm, EmptyState } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { Layers, Plus, Trash2, Pencil, X, Key } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  };

  useEffect(load, []);

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

  const renderRow = (env: EnvironmentData) => {
    const isEditing = editing === env.id;

    if (isEditing) {
      return (
        <div key={env.id} className="px-4 py-3 space-y-3 bg-alt/30">
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Environment name"
              className="!text-[10px] font-bold uppercase"
              autoFocus
            />
            <button onClick={() => setEditing(null)} className="text-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
          <EnvVarEditor entries={editVars} onChange={setEditVars} />
          <div className="flex gap-2 justify-end">
            <Btn size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn size="xs" variant="primary" loading={loading} disabled={!editName.trim()} onClick={save}>Save</Btn>
          </div>
        </div>
      );
    }

    return (
      <div key={env.id} className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-[10px] font-bold text-fg uppercase">{env.name}</span>
          <span className="font-mono text-[9px] text-muted flex items-center gap-1">
            <Key size={9} /> {env.env_vars.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Btn size="xs" variant="ghost" onClick={() => startEdit(env)} title="Edit">
            <Pencil size={12} />
          </Btn>
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
    );
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Environments</h1>
        <Btn size="sm" variant="primary" onClick={startNew}>
          <Plus size={12} /> New
        </Btn>
      </div>

      {environments.length > 0 || editing === "new" ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-fg/10">
            {/* New environment form — inline at top */}
            {editing === "new" && (
              <div className="px-4 py-3 space-y-3 bg-alt/30">
                <div className="flex items-center justify-between">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Environment name"
                    className="!text-[10px] font-bold uppercase"
                    autoFocus
                  />
                  <button onClick={() => setEditing(null)} className="text-muted hover:text-fg">
                    <X size={14} />
                  </button>
                </div>
                <EnvVarEditor entries={editVars} onChange={setEditVars} />
                <div className="flex gap-2 justify-end">
                  <Btn size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                  <Btn size="xs" variant="primary" loading={loading} disabled={!editName.trim()} onClick={save}>Create</Btn>
                </div>
              </div>
            )}
            {environments.map(renderRow)}
          </div>
        </Card>
      ) : (
        <EmptyState message="No environments yet" icon={Layers} />
      )}
    </div>
  );
}
