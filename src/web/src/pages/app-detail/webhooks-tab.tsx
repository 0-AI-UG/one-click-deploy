import { useState, useEffect } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, Field, StatusBadge, Spinner, confirm, showToast } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { InfoTip } from "./shared.tsx";
import { GitBranch, ArrowUpCircle, ExternalLink, Rocket } from "lucide-react";
import type { AppData, EnvironmentData } from "../../types.ts";
import type { AppStagingResponse } from "../../../../shared/rpc.ts";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface WebhooksTabProps {
  app: AppData;
  appId: number;
  webhookForm: { branch: string; path: string; waitForCi: boolean; stagingEnvId: number | null };
  setWebhookForm: (f: { branch: string; path: string; waitForCi: boolean; stagingEnvId: number | null }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

// Options for the "deploy to staging first" environment picker: an explicit
// "Off" plus one entry per environment. Staging is on iff an environment is
// selected; the sibling deploys with exactly that environment (no inheritance).
const OFF = "";
function envOptions(envs: EnvironmentData[]): { value: string; label: string }[] {
  return [{ value: OFF, label: "Off — deploy production directly" }, ...envs.map((e) => ({ value: String(e.id), label: e.name }))];
}

// The staging panel: shown when the webhook is enabled. Picking an environment
// turns staging on — webhook pushes then build the hidden <name>-staging sibling
// (deployed with the chosen environment) and hold, and this panel surfaces that
// sibling plus a Promote-to-production button (the existing promote op).
function StagingPanel({ app, appId, envs, actionLoading, action, ops }: Omit<WebhooksTabProps, "webhookForm" | "setWebhookForm"> & { envs: EnvironmentData[] }) {
  const [data, setData] = useState<AppStagingResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await get(`/api/apps/${appId}/staging`));
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [appId]);

  const stagingEnvId = data?.staging_environment_id ?? app.webhook_staging_environment_id ?? null;
  const enabled = stagingEnvId != null;

  const selectEnv = (next: number | null) =>
    action("toggle-staging", async () => {
      await post(`/api/apps/${appId}/webhook/settings`, { staging_environment_id: next });
      await load();
    });

  const sibling = data?.sibling ?? null;
  const prodCommit = data?.prod_commit ?? null;
  // Staging is "ahead" (worth promoting) once it has a deployed commit that
  // differs from production's.
  const canPromote = !!sibling?.commit && sibling.commit !== prodCommit;

  const promote = async () => {
    if (!sibling) return;
    if (await confirm(
      "Promote to production",
      `Promote ${sibling.name} → ${app.name}? This rebuilds production at the commit currently running in staging (${sibling.commit?.slice(0, 7)}).`,
    )) {
      await action("promote", async () => {
        const res = (await post("/api/apps/promote", { source_app: sibling.name, dest_app: app.name })) as { op_id?: number };
        if (res?.op_id) {
          trackOperationInToast(res.op_id, "Promoting to production");
          ops.track(res.op_id);
        }
      });
      load();
    }
  };

  const selectedName = envs.find((e) => e.id === stagingEnvId)?.name;

  return (
    <div className="mt-3 pt-3 border-t-2 border-fg/10 space-y-3">
      <div className="flex items-center gap-2 text-[10px] font-mono">
        <span className="text-muted">Deploy to staging first</span>
        <InfoTip text="Pick an environment to build the hidden <name>-staging sibling on each push and hold — production is swapped only when you click Promote. The sibling deploys with the environment you choose; duplicate production's environment first if you want isolated staging values. Off: pushes redeploy production directly." />
      </div>
      <PermissionGate
        permission="webhooks.manage"
        fallback={
          <div className="text-[10px] font-mono font-bold text-fg">{enabled ? (selectedName ?? "On") : "Off"}</div>
        }
      >
        <NeoSelect
          compact
          value={stagingEnvId != null ? String(stagingEnvId) : OFF}
          options={envOptions(envs)}
          onChange={(v) => selectEnv(v ? parseInt(v, 10) : null)}
        />
      </PermissionGate>

      {enabled && (
        loading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : sibling ? (
          <div className="border-2 border-fg bg-alt/40 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Rocket size={13} className="text-fg" />
              <span className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Staging</span>
              <StatusBadge status={sibling.status} />
              <a
                href={`#/apps/${sibling.id}`}
                className="ml-auto flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-accent-blue hover:underline"
              >
                Open <ExternalLink size={11} />
              </a>
            </div>
            <div className="space-y-1 text-[10px] font-mono">
              <div className="flex justify-between"><span className="text-muted">Environment</span><span className="text-fg">{selectedName ?? `#${stagingEnvId}`}</span></div>
              <div className="flex justify-between"><span className="text-muted">Staging commit</span><span className="text-fg">{sibling.commit ? sibling.commit.slice(0, 7) : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Production commit</span><span className="text-fg">{prodCommit ? prodCommit.slice(0, 7) : "—"}</span></div>
              {sibling.domain && (
                <div className="flex justify-between">
                  <span className="text-muted">Preview</span>
                  <a href={`https://${sibling.domain}`} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline">{sibling.domain}</a>
                </div>
              )}
            </div>
            <PermissionGate permission="apps.deploy">
              <Btn
                size="xs"
                variant="primary"
                disabled={ops.isBusy || !canPromote}
                loading={ops.isBusyWith("promote")}
                onClick={promote}
              >
                <ArrowUpCircle size={13} /> Promote to production
              </Btn>
              {!canPromote && sibling.commit && (
                <p className="text-[10px] font-mono text-muted">Staging matches production — nothing to promote.</p>
              )}
            </PermissionGate>
            <p className="text-[10px] font-mono text-muted leading-snug">
              Staging deploys with the <span className="text-fg">{selectedName ?? "selected"}</span> environment. Edit or <a href="#/environments" className="text-accent-blue hover:underline">duplicate an environment</a> to change its values.
            </p>
          </div>
        ) : (
          <div className="border-2 border-dashed border-fg/30 bg-alt/20 p-3">
            <p className="text-[10px] font-mono text-muted leading-snug">
              No staging deploy yet. Push to <span className="text-fg font-bold">{app.webhook_branch}</span> and the <span className="text-fg font-bold">{app.name}-staging</span> sibling is built with the <span className="text-fg font-bold">{selectedName ?? "selected"}</span> environment — then promote it here.
            </p>
          </div>
        )
      )}
    </div>
  );
}

export function WebhooksTab({ app, appId, webhookForm, setWebhookForm, actionLoading, action, ops }: WebhooksTabProps) {
  const [envs, setEnvs] = useState<EnvironmentData[]>([]);
  useEffect(() => { get("/api/environments").then(setEnvs).catch(() => {}); }, []);

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
            <div className="flex justify-between"><span className="text-muted">Wait for CI</span><span>{app.webhook_wait_for_ci ? "Yes" : "No"}</span></div>
          </>
        )}
      </div>
      <PermissionGate permission="webhooks.manage">
        {app.webhook_enabled ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[10px] font-mono cursor-pointer">
              <input
                type="checkbox"
                checked={!!app.webhook_wait_for_ci}
                onChange={(e) => action("update-webhook-ci", () => post(`/api/apps/${appId}/webhook/settings`, { wait_for_ci: e.target.checked }))}
                className="accent-accent"
              />
              <span className="text-muted">Wait for CI checks before deploying</span>
            </label>
            <Btn size="xs" variant="danger" loading={actionLoading === "disable-webhook"} onClick={() => action("disable-webhook", () => post(`/api/apps/${appId}/webhook/disable`))}>
              Disable Webhook
            </Btn>
          </div>
        ) : (
          <div className="space-y-2">
            <Field label="Branch">
              <input
                type="text"
                value={webhookForm.branch}
                onChange={(e) => setWebhookForm({ ...webhookForm, branch: e.target.value })}
                placeholder="main"
              />
            </Field>
            <Field label="Path filter (optional)">
              <input
                type="text"
                value={webhookForm.path}
                onChange={(e) => setWebhookForm({ ...webhookForm, path: e.target.value })}
                placeholder="e.g. services/api"
              />
            </Field>
            <label className="flex items-center gap-2 text-[10px] font-mono cursor-pointer">
              <input
                type="checkbox"
                checked={webhookForm.waitForCi}
                onChange={(e) => setWebhookForm({ ...webhookForm, waitForCi: e.target.checked })}
                className="accent-accent"
              />
              <span className="text-muted">Wait for CI checks before deploying</span>
            </label>
            <Field label="Deploy to staging first (optional)">
              <NeoSelect
                value={webhookForm.stagingEnvId != null ? String(webhookForm.stagingEnvId) : OFF}
                options={envOptions(envs)}
                onChange={(v) => setWebhookForm({ ...webhookForm, stagingEnvId: v ? parseInt(v, 10) : null })}
              />
            </Field>
            <p className="text-[10px] font-mono text-muted leading-snug">
              Pick an environment to hold pushes in a <span className="text-fg">{app.name}-staging</span> sibling for manual promotion. Duplicate production's environment on the <a href="#/environments" className="text-accent-blue hover:underline">Environments</a> page for isolated staging values.
            </p>
            <Btn size="xs" variant="primary" loading={actionLoading === "enable-webhook"} onClick={() => action("enable-webhook", () => post(`/api/apps/${appId}/webhook/enable`, { branch: webhookForm.branch || "main", path: webhookForm.path || undefined, wait_for_ci: webhookForm.waitForCi, staging_environment_id: webhookForm.stagingEnvId }))}>
              Enable Webhook
            </Btn>
          </div>
        )}
      </PermissionGate>

      {app.webhook_enabled && (
        <StagingPanel app={app} appId={appId} envs={envs} actionLoading={actionLoading} action={action} ops={ops} />
      )}
    </Card>
  );
}
