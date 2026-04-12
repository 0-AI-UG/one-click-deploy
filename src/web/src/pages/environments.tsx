import { useState, useEffect } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Card, Btn, showToast, confirm } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { Layers, Plus, Trash2, Pencil } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    get("/api/environments").then((r) => r.json()).then(setEnvironments).catch(() => {});
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
        await post("/api/environments", { name: editName, env_vars: vars }).then((r) => r.json());
        showToast("Environment created");
      } else {
        await put(`/api/environments/${editing}`, { name: editName, env_vars: vars });
        showToast("Environment updated");
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
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers size={16} className="text-fg" />
          <h1 className="font-mono text-sm font-bold text-fg uppercase tracking-wider">Environments</h1>
        </div>
        <Btn size="sm" variant="primary" onClick={startNew}>
          <Plus size={12} /> New Environment
        </Btn>
      </div>
      <p className="text-[10px] text-muted font-mono">
        Environments are shared sets of key-value pairs. Attach an environment to an app to inject its variables. App-specific vars override environment vars.
      </p>

      {editing !== null && (
        <Card className="p-4 space-y-3 border border-accent-blue/30">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Environment name (e.g. production, staging)"
            className="w-full"
          />
          <EnvVarEditor entries={editVars} onChange={setEditVars} />
          <div className="flex gap-2 justify-end">
            <Btn size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn size="sm" variant="primary" loading={loading} disabled={!editName.trim()} onClick={save}>
              {editing === "new" ? "Create" : "Save"}
            </Btn>
          </div>
        </Card>
      )}

      {environments.map((env) => (
        <Card key={env.id} className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold text-fg">{env.name}</span>
              <span className="font-mono text-[9px] text-muted">{env.env_vars.length} var{env.env_vars.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => startEdit(env)} className="text-muted hover:text-fg">
                <Pencil size={12} />
              </button>
              <button
                onClick={async () => {
                  if (await confirm("Delete Environment", `Delete "${env.name}"? Apps using it will be unassigned.`, true)) {
                    await del(`/api/environments/${env.id}`);
                    load();
                  }
                }}
                className="text-muted hover:text-accent-red"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          {env.env_vars.length > 0 && (
            <div className="space-y-1 text-[10px] font-mono">
              {env.env_vars.map((e) => (
                <div key={e.key} className="flex justify-between gap-4">
                  <span className="text-accent-blue font-bold">{e.key}</span>
                  <span className="text-fg-dim truncate">{e.secret ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : e.value}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}

      {environments.length === 0 && editing === null && (
        <Card className="p-6 text-center">
          <p className="text-[10px] text-muted font-mono">No environments yet. Create one to share env vars across apps.</p>
        </Card>
      )}
    </div>
  );
}
