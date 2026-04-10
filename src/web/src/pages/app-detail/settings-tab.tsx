import { post, put } from "../../api/client.ts";
import { Card, Btn, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Pencil, Lock, Settings as SettingsIcon, HardDrive, Plus, Minus } from "lucide-react";
import type { AppData } from "../../types.ts";

interface SettingsTabProps {
  app: AppData;
  appId: number;
  nameEdit: string;
  setNameEdit: (v: string) => void;
  authPassword: string;
  setAuthPassword: (v: string) => void;
  portEdit: number;
  setPortEdit: (v: number) => void;
  envEdit: { key: string; value: string }[];
  setEnvEdit: (v: { key: string; value: string }[]) => void;
  volumeForm: { size: number; mount_path: string };
  setVolumeForm: (f: { size: number; mount_path: string }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
}

export function SettingsTab({
  app, appId,
  nameEdit, setNameEdit,
  authPassword, setAuthPassword,
  portEdit, setPortEdit,
  envEdit, setEnvEdit,
  volumeForm, setVolumeForm,
  actionLoading, action,
}: SettingsTabProps) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Pencil size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">App Name</h3>
        </div>
        <p className="text-[10px] text-muted font-mono mb-3">
          Rename this app. This changes the container name and app directory on the server.
        </p>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={nameEdit}
            onChange={(e) => setNameEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            placeholder={app.name}
          />
          <PermissionGate permission="apps.deploy">
            <Btn
              size="sm"
              variant="primary"
              loading={actionLoading === "rename"}
              disabled={!nameEdit || nameEdit === app.name}
              onClick={() => action("rename", async () => {
                await put(`/api/apps/${appId}/rename`, { name: nameEdit });
              })}
            >Rename</Btn>
          </PermissionGate>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Lock size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Password Protection</h3>
        </div>
        <p className="text-[10px] text-muted font-mono mb-3">
          Set a password to gate access to this app. Leave blank to remove. Saving triggers a redeploy.
        </p>
        <input
          type="password"
          value={authPassword}
          onChange={(e) => setAuthPassword(e.target.value)}
          placeholder="(none)"
        />
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <SettingsIcon size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container Port</h3>
        </div>
        <p className="text-[10px] text-muted font-mono mb-3">
          The port your app listens on inside the container. Saving triggers a rebuild and redeploy.
        </p>
        <input
          type="number"
          min={1}
          max={65535}
          value={portEdit || ""}
          onChange={(e) => setPortEdit(parseInt(e.target.value) || 0)}
          placeholder="3000"
        />
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <SettingsIcon size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Environment Variables</h3>
          </div>
          <Btn size="xs" variant="ghost" onClick={() => setEnvEdit([...envEdit, { key: "", value: "" }])}>
            <Plus size={12} /> Add
          </Btn>
        </div>
        {envEdit.length === 0 ? (
          <p className="text-[10px] text-muted font-mono mb-2">No environment variables.</p>
        ) : (
          envEdit.map((v, i) => (
            <div key={i} className="flex gap-2 items-center mt-2">
              <input
                type="text"
                value={v.key}
                placeholder="KEY"
                onChange={(e) => {
                  const next = [...envEdit];
                  next[i].key = e.target.value;
                  setEnvEdit(next);
                }}
                className="!w-1/3"
              />
              <input
                type="text"
                value={v.value}
                placeholder="value"
                onChange={(e) => {
                  const next = [...envEdit];
                  next[i].value = e.target.value;
                  setEnvEdit(next);
                }}
              />
              <button
                type="button"
                onClick={() => setEnvEdit(envEdit.filter((_, j) => j !== i))}
                className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
              >
                <Minus size={14} />
              </button>
            </div>
          ))
        )}
      </Card>

      <PermissionGate permission="apps.redeploy">
        <div className="flex justify-end">
          <Btn
            size="sm"
            variant="primary"
            loading={actionLoading === "save-settings"}
            disabled={!portEdit}
            onClick={() => action("save-settings", async () => {
              const env_vars: Record<string, string> = {};
              for (const { key, value } of envEdit) {
                if (key.trim()) env_vars[key.trim()] = value;
              }
              await post(`/api/apps/${appId}/redeploy`, {
                env_vars,
                auth_password: authPassword || null,
                container_port: portEdit,
              });
            })}
          >Save & Redeploy</Btn>
        </div>
      </PermissionGate>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <HardDrive size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Persistent Volume</h3>
        </div>
        {app.volume_id ? (
          <>
            <div className="space-y-1 text-[10px] font-mono mb-3">
              <div className="flex justify-between"><span className="text-muted">Volume ID</span><span className="text-fg">{app.volume_id}</span></div>
              <div className="flex justify-between"><span className="text-muted">Mount</span><span className="text-fg">{app.volume_mount}</span></div>
            </div>
            <p className="text-[10px] text-muted font-mono mb-3">
              Detaching keeps the volume in Hetzner but unmounts it from this app. The container will be recreated.
            </p>
            <PermissionGate permission="volumes.manage">
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="danger"
                  loading={actionLoading === "detach-vol"}
                  onClick={async () => {
                    if (await confirm("Detach Volume", "Detach this volume? Data is preserved on the volume itself.", true)) {
                      await action("detach-vol", () => post(`/api/volumes/detach`, { app_id: appId }));
                    }
                  }}
                >Detach Volume</Btn>
              </div>
            </PermissionGate>
          </>
        ) : (
          <>
            <p className="text-[10px] text-muted font-mono mb-3">
              Attach a new persistent volume. The container will be recreated with the volume mounted.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Size (GB)</label>
                <input
                  type="number"
                  min={10}
                  value={volumeForm.size}
                  onChange={(e) => setVolumeForm({ ...volumeForm, size: parseInt(e.target.value) || 10 })}
                />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Mount Path</label>
                <input
                  type="text"
                  value={volumeForm.mount_path}
                  onChange={(e) => setVolumeForm({ ...volumeForm, mount_path: e.target.value })}
                  placeholder="/data"
                />
              </div>
            </div>
            <PermissionGate permission="volumes.create">
              <div className="flex justify-end mt-3">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "attach-vol"}
                  onClick={() => action("attach-vol", () => post(`/api/volumes/attach`, {
                    app_id: appId,
                    size: volumeForm.size,
                    mount_path: volumeForm.mount_path || "/data",
                  }))}
                >Attach Volume</Btn>
              </div>
            </PermissionGate>
          </>
        )}
      </Card>
    </div>
  );
}
