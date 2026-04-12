import { post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Pencil, Lock, Settings as SettingsIcon, HardDrive, Globe } from "lucide-react";
import type { AppData } from "../../types.ts";

interface SettingsTabProps {
  app: AppData;
  appId: number;
  nameEdit: string;
  setNameEdit: (v: string) => void;
  authPassword: string;
  setAuthPassword: (v: string) => void;
  isPublic: boolean;
  setIsPublic: (v: boolean) => void;
  portEdit: number;
  setPortEdit: (v: number) => void;
  volumeForm: { size: number; mount_path: string };
  setVolumeForm: (f: { size: number; mount_path: string }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
}

export function SettingsTab({
  app, appId,
  nameEdit, setNameEdit,
  authPassword, setAuthPassword,
  isPublic, setIsPublic,
  portEdit, setPortEdit,
  volumeForm, setVolumeForm,
  actionLoading, action,
}: SettingsTabProps) {
  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Pencil size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">App Name</h3>
          </div>
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
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Lock size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Password Protection</h3>
          </div>
          <input
            type="password"
            value={authPassword}
            onChange={(e) => setAuthPassword(e.target.value)}
            placeholder="(none)"
          />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Globe size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Public Access</h3>
          </div>
          <Checkbox
            checked={isPublic}
            onChange={setIsPublic}
            label="Expose via public domain"
          />
          {!isPublic && <p className="text-[9px] text-muted mt-1">App will only be reachable over the internal network</p>}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <SettingsIcon size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Container Port</h3>
          </div>
          <input
            type="number"
            min={1}
            max={65535}
            value={portEdit || ""}
            onChange={(e) => setPortEdit(parseInt(e.target.value) || 0)}
            placeholder="3000"
          />
        </div>
      </Card>

      <PermissionGate permission="apps.redeploy">
        <div className="flex justify-end">
          <Btn
            size="sm"
            variant="primary"
            loading={actionLoading === "save-settings"}
            disabled={!portEdit}
            onClick={() => action("save-settings", async () => {
              await post(`/api/apps/${appId}/redeploy`, {
                auth_password: authPassword || null,
                container_port: portEdit,
                public: isPublic,
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
