import { post } from "../../api/client.ts";
import { Card, Btn } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { GitBranch } from "lucide-react";

interface WebhooksTabProps {
  app: any;
  appId: number;
  webhookForm: { branch: string; path: string };
  setWebhookForm: (f: { branch: string; path: string }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<any>) => Promise<void>;
}

export function WebhooksTab({ app, appId, webhookForm, setWebhookForm, actionLoading, action }: WebhooksTabProps) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <GitBranch size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Webhook</h3>
      </div>
      <div className="space-y-2 text-[10px] font-mono mb-4">
        <div className="flex justify-between"><span className="text-muted">Status</span><span className={`font-bold ${app.webhook_enabled ? "text-fg" : "text-muted"}`}>{app.webhook_enabled ? "Enabled" : "Disabled"}</span></div>
        {app.webhook_enabled && (
          <>
            <div className="flex justify-between"><span className="text-muted">Branch</span><span>{app.webhook_branch}</span></div>
            <div className="flex justify-between"><span className="text-muted">Path filter</span><span>{app.webhook_path || "—"}</span></div>
          </>
        )}
      </div>
      <PermissionGate permission="webhooks.manage">
        {app.webhook_enabled ? (
          <Btn size="xs" variant="danger" loading={actionLoading === "disable-webhook"} onClick={() => action("disable-webhook", () => post(`/api/apps/${appId}/webhook/disable`))}>
            Disable Webhook
          </Btn>
        ) : (
          <div className="space-y-2">
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Branch</label>
              <input
                type="text"
                value={webhookForm.branch}
                onChange={(e) => setWebhookForm({ ...webhookForm, branch: e.target.value })}
                placeholder="main"
              />
            </div>
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Path filter (optional)</label>
              <input
                type="text"
                value={webhookForm.path}
                onChange={(e) => setWebhookForm({ ...webhookForm, path: e.target.value })}
                placeholder="e.g. services/api"
              />
            </div>
            <Btn size="xs" variant="primary" loading={actionLoading === "enable-webhook"} onClick={() => action("enable-webhook", () => post(`/api/apps/${appId}/webhook/enable`, { branch: webhookForm.branch || "main", path: webhookForm.path || undefined }))}>
              Enable Webhook
            </Btn>
          </div>
        )}
      </PermissionGate>
    </Card>
  );
}
