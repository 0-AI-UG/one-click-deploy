import { post } from "../../api/client.ts";
import { Card, Btn, Field, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { HardDrive, TerminalSquare } from "lucide-react";
import type { AppData } from "../../types.ts";

interface SettingsTabProps {
  app: AppData;
  appId: number;
  volumeForm: { size: number; mount_path: string };
  setVolumeForm: (form: { size: number; mount_path: string }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function SettingsTab({
  app,
  appId,
  volumeForm,
  setVolumeForm,
  actionLoading,
  action,
  ops,
}: SettingsTabProps) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <TerminalSquare size={15} className="mt-0.5 shrink-0 text-fg" />
          <div>
            <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">CLI-controlled configuration</h3>
            <p className="mt-1 font-mono text-[10px] text-muted">
              App name, source, build, domains, ingress, environment linkage, resources, health checks, scaling, storage declarations, and webhooks come from <code>.ocd-deploy.json</code>.
            </p>
            <p className="mt-2 font-mono text-[10px] text-fg">
              Run <code>ocd deploy --dry-run</code>, then <code>ocd deploy</code> from the app repository.
            </p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <HardDrive size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Persistent volume operation</h3>
        </div>
        {app.volume_id ? (
          <>
            <div className="mb-3 space-y-1 font-mono text-[10px]">
              <div className="flex justify-between"><span className="text-muted">Volume ID</span><span className="text-fg">{app.volume_id}</span></div>
              <div className="flex justify-between"><span className="text-muted">Mount</span><span className="text-fg">{app.volume_mount}</span></div>
            </div>
            <PermissionGate permission="volumes.detach">
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="danger"
                  loading={actionLoading === "detach-vol" || ops.isBusyWith("detach_volume")}
                  disabled={ops.isBusy}
                  onClick={async () => {
                    if (!await confirm("Detach Volume", "Detach this volume? Its data is retained.", true)) return;
                    await action("detach-vol", async () => {
                      const result = await post("/api/volumes/detach", { app_id: appId }) as { op_id?: number };
                      if (result.op_id) {
                        trackOperationInToast(result.op_id, "Detaching volume");
                        ops.track(result.op_id);
                      }
                    });
                  }}
                >
                  Detach volume
                </Btn>
              </div>
            </PermissionGate>
          </>
        ) : (
          <>
            <p className="mb-3 font-mono text-[9px] text-muted">
              Explicit volume attachment is an operational recovery/migration action. Declare storage in the manifest for normal app creation.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Size (GB)">
                <input
                  type="number"
                  min={10}
                  value={volumeForm.size}
                  onChange={(event) => setVolumeForm({ ...volumeForm, size: parseInt(event.target.value, 10) || 10 })}
                />
              </Field>
              <Field label="Mount path">
                <input
                  type="text"
                  value={volumeForm.mount_path}
                  onChange={(event) => setVolumeForm({ ...volumeForm, mount_path: event.target.value })}
                  placeholder="/data"
                />
              </Field>
            </div>
            <PermissionGate permission="volumes.attach">
              <div className="mt-3 flex justify-end">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "attach-vol" || ops.isBusyWith("attach_volume")}
                  disabled={ops.isBusy}
                  onClick={() => action("attach-vol", async () => {
                    const result = await post("/api/volumes/attach", {
                      app_id: appId,
                      size: volumeForm.size,
                      mount_path: volumeForm.mount_path || "/data",
                    }) as { op_id?: number };
                    if (result.op_id) {
                      trackOperationInToast(result.op_id, "Attaching volume");
                      ops.track(result.op_id);
                    }
                  })}
                >
                  Attach volume
                </Btn>
              </div>
            </PermissionGate>
          </>
        )}
      </Card>
    </div>
  );
}
