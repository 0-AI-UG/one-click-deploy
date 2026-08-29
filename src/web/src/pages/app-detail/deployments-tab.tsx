import { useState } from "react";
import { runCliAction } from "../../api/cli-actions.ts";
import { Card, Btn, StatusBadge, Table, CopyButton, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { Clock } from "lucide-react";
import type { DeploymentRecord } from "../../types.ts";

interface DeploymentsTabProps {
  appId: number;
  deployments: DeploymentRecord[];
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function DeploymentsTab({ appId, deployments, action, ops }: DeploymentsTabProps) {
  const [image, setImage] = useState("");
  const [commit, setCommit] = useState("");
  const [showRelease, setShowRelease] = useState(false);

  const release = async () => {
    if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image.trim())) {
      showToast("Use an immutable repository@sha256 digest", "error");
      return;
    }
    if (commit && !/^[a-f0-9]{7,64}$/i.test(commit)) {
      showToast("Commit must be 7-64 hexadecimal characters", "error");
      return;
    }
    await action("release", () => runCliAction("app.release", { app: String(appId), image: image.trim(), commit: commit || undefined }));
    setShowRelease(false);
    setImage("");
    setCommit("");
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Delivery actions</h3>
            <p className="mt-1 text-[10px] text-muted">Recreate the stored artifact or release a new immutable digest through the OCD CLI.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PermissionGate permission="apps.deploy" appId={appId}>
              <Btn size="xs" disabled={ops.isBusy} onClick={() => action("redeploy", () => runCliAction("app.redeploy", { app: String(appId) }))}>Redeploy current</Btn>
            </PermissionGate>
            <PermissionGate permission="apps.restart" appId={appId}>
              <Btn size="xs" disabled={ops.isBusy} onClick={async () => {
                if (await confirm("Reload environment", "Recreate this app from its current immutable image using the latest linked environment values?", true)) {
                  await action("reload environment", () => runCliAction("app.reload-env", { app: String(appId) }, { confirmed: true }));
                }
              }}>Reload environment</Btn>
            </PermissionGate>
            <PermissionGate permission="apps.deploy" appId={appId}>
              <Btn size="xs" variant="primary" onClick={() => setShowRelease((open) => !open)}>Release digest</Btn>
            </PermissionGate>
          </div>
        </div>
        {showRelease && <div className="grid gap-2 border-t-2 border-fg pt-3 md:grid-cols-[1fr_180px_auto]">
          <input value={image} onChange={(event) => setImage(event.target.value)} placeholder="registry.example.com/team/app@sha256:…" />
          <input value={commit} onChange={(event) => setCommit(event.target.value.trim())} placeholder="Source commit (optional)" />
          <Btn variant="primary" disabled={ops.isBusy || !image.trim()} onClick={release}>Release</Btn>
        </div>}
      </Card>

    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deployment History</h3>
      </div>
      {deployments.length === 0 ? (
        <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No deployments yet</p>
      ) : (
        <Table headers={["ID", "Image", "Digest", "Commit", "Config", "Source", "Status", "Date", ""]}>
          {deployments.map((d) => (
            <tr key={d.id} className="hover:bg-alt/50">
              <td className="py-2 px-3 text-fg font-bold">#{d.id}</td>
              <td className="py-2 px-3 text-fg-dim">{d.image_tag}</td>
              <td className="py-2 px-3 text-fg-dim font-mono" title={d.image_digest}>
                {d.image_digest ? d.image_digest.split("@sha256:").pop()?.slice(0, 12) : "—"}
              </td>
              <td className="py-2 px-3 text-fg-dim">{d.git_commit?.slice(0, 7) || "—"}</td>
              <td className="py-2 px-3 text-fg-dim">r{d.config_revision ?? 1}</td>
              <td className="py-2 px-3 text-fg-dim uppercase tracking-wider text-[9px]">{d.source || "manual"}</td>
              <td className="py-2 px-3"><StatusBadge status={d.status} /></td>
              <td className="py-2 px-3 text-muted">{new Date(d.created_at + "Z").toLocaleString()}</td>
              <td className="py-2 px-3 flex items-center gap-1">
                {d.status === "failed" && d.deploy_log && (
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-[9px] text-accent-red max-w-[200px] truncate" title={d.deploy_log}>{d.deploy_log}</span>
                    <CopyButton text={d.deploy_log} size={10} />
                  </span>
                )}
                {d.status !== "failed" && (
                  <PermissionGate permission="apps.rollback" appId={appId}>
                    <Btn
                      size="xs" variant="ghost"
                      disabled={ops.isBusy}
                      loading={ops.isBusyWith("rollback")}
                      onClick={async () => {
                        if (await confirm("Rollback", `Rollback to deployment #${d.id}?`)) {
                          action("rollback", () => runCliAction("app.rollback", {
                            app: String(appId),
                            deployment: String(d.id),
                          }));
                        }
                      }}
                    >Rollback</Btn>
                  </PermissionGate>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
    </div>
  );
}
