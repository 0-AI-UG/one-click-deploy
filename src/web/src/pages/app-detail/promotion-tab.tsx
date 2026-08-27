import { useEffect, useState } from "react";
import { get } from "../../api/client.ts";
import { Card, Btn, StatusBadge, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { ArrowUpCircle, ExternalLink, Rocket } from "lucide-react";
import type { AppData } from "../../types.ts";
import type { AppStagingResponse } from "../../../../shared/rpc.ts";
import { serverConfirmedAction } from "../../api/server-confirmation.ts";

const errMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface PromotionTabProps {
  app: AppData;
  appId: number;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function PromotionTab({ app, appId, action, ops }: PromotionTabProps) {
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
  const canPromote = sibling?.status === "running";

  const promote = async () => {
    if (!sibling) return;
    if (!await confirm(
      "Promote to production",
      `Promote the exact immutable image running in ${sibling.name} to ${app.name}?`,
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
        trackOperationInToast(result.op_id, "Promoting immutable image to production");
        ops.track(result.op_id);
      }
    });
    await load();
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Rocket size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Staging promotion</h3>
        {sibling && <StatusBadge status={sibling.status} />}
        {sibling && (
          <a href={`#/apps/${sibling.id}`} className="ml-auto flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-accent-blue hover:underline">
            Open <ExternalLink size={11} />
          </a>
        )}
      </div>
      {!sibling ? (
        <p className="font-mono text-[10px] text-muted">No staging sibling is connected to this app.</p>
      ) : (
        <>
          <div className="mb-3 space-y-1 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-muted">Source app</span><span>{sibling.name}</span></div>
            {sibling.domain && <div className="flex justify-between"><span className="text-muted">Staging URL</span><a href={`https://${sibling.domain}`} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline">{sibling.domain}</a></div>}
          </div>
          <PermissionGate permission="apps.promote" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" variant="primary" disabled={ops.isBusy || !canPromote} loading={ops.isBusyWith("promote")} onClick={promote}>
              <ArrowUpCircle size={13} /> Promote exact image
            </Btn>
          </PermissionGate>
          {!canPromote && <p className="mt-2 font-mono text-[10px] text-muted">The staging app must be running before it can be promoted.</p>}
        </>
      )}
    </Card>
  );
}
