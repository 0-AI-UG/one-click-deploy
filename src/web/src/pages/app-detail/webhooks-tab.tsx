import { useEffect, useState } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { GitBranch, ArrowUpCircle, ExternalLink, Rocket } from "lucide-react";
import type { AppData } from "../../types.ts";
import type { AppStagingResponse } from "../../../../shared/rpc.ts";
import { serverConfirmedAction } from "../../api/server-confirmation.ts";

const errMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface WebhooksTabProps {
  app: AppData;
  appId: number;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function WebhooksTab({ app, appId, action, ops }: WebhooksTabProps) {
  const [staging, setStaging] = useState<AppStagingResponse | null>(null);

  const load = async () => {
    try {
      setStaging(await get(`/api/apps/${appId}/staging`));
    } catch (error) {
      showToast(errMessage(error), "error");
    }
  };

  useEffect(() => { load(); }, [appId]);

  const sibling = staging?.sibling ?? null;
  const productionCommit = staging?.prod_commit ?? null;
  const canPromote = Boolean(sibling?.commit && sibling.commit !== productionCommit);

  const promote = async () => {
    if (!sibling?.commit) return;
    if (!await confirm(
      "Promote to production",
      `Promote ${sibling.name} → ${app.name} at ${sibling.commit.slice(0, 7)}?`,
    )) return;

    await action("promote", async () => {
      const result = await serverConfirmedAction<{ op_id?: number }>(
        "/api/apps/promote",
        "POST",
        "promote_app",
        "promotion",
        `${sibling.id}:${appId}`,
        { source_app: sibling.name, dest_app: app.name },
      );
      if (result.op_id) {
        trackOperationInToast(result.op_id, "Promoting to production");
        ops.track(result.op_id);
      }
    });
    await load();
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Webhook</h3>
        </div>
        <div className="space-y-2 font-mono text-[10px]">
          <div className="flex justify-between"><span className="text-muted">Status</span><span className={app.webhook_enabled ? "font-bold text-fg" : "text-muted"}>{app.webhook_enabled ? "Enabled" : "Disabled"}</span></div>
          {app.webhook_enabled && (
            <>
              <div className="flex justify-between"><span className="text-muted">Branch</span><span>{app.webhook_branch || "main"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Paths</span><span className="text-right">{app.webhook_paths?.length ? app.webhook_paths.join(", ") : "All pushes"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Paths ignored</span><span className="text-right">{app.webhook_paths_ignore?.length ? app.webhook_paths_ignore.join(", ") : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Wait for CI</span><span>{app.webhook_wait_for_ci ? "Yes" : "No"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Last received</span><span>{app.last_webhook_head?.slice(0, 12) || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Last evaluated</span><span>{app.last_evaluated_commit?.slice(0, 12) || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Last CI result</span><span>{app.last_webhook_ci_result || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Last decision</span><span>{app.last_decision || "—"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Last matching paths</span><span className="text-right">{app.last_matching_paths?.join(", ") || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Last deployed commit</span><span>{app.last_successfully_deployed_commit?.slice(0, 12) || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Staging environment</span><span>{staging?.staging_environment_id == null ? "Off" : `#${staging.staging_environment_id}`}</span></div>
            </>
          )}
        </div>
      </Card>

      {sibling && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Rocket size={14} className="text-fg" />
            <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Staging</h3>
            <StatusBadge status={sibling.status} />
            <a href={`#/apps/${sibling.id}`} className="ml-auto flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-accent-blue hover:underline">
              Open <ExternalLink size={11} />
            </a>
          </div>
          <div className="mb-3 space-y-1 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-muted">Staging commit</span><span>{sibling.commit?.slice(0, 7) || "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted">Production commit</span><span>{productionCommit?.slice(0, 7) || "—"}</span></div>
            {sibling.domain && <div className="flex justify-between"><span className="text-muted">Preview</span><a href={`https://${sibling.domain}`} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline">{sibling.domain}</a></div>}
          </div>
          <PermissionGate permission="apps.promote" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" variant="primary" disabled={ops.isBusy || !canPromote} loading={ops.isBusyWith("promote")} onClick={promote}>
              <ArrowUpCircle size={13} /> Promote to production
            </Btn>
          </PermissionGate>
          {!canPromote && sibling.commit && <p className="mt-2 font-mono text-[10px] text-muted">Staging matches production.</p>}
        </Card>
      )}
    </div>
  );
}
