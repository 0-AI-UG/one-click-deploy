import { useState, useEffect } from "react";
import { get, post } from "../../api/client.ts";
import { Card, Btn, Field, StatusBadge, confirm, showToast } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { InfoTip } from "./shared.tsx";
import { GitBranch, ArrowUpCircle, ExternalLink, Rocket, Check, X } from "lucide-react";
import type { AppData, EnvironmentData } from "../../types.ts";
import type { AppStagingResponse } from "../../../../shared/rpc.ts";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const STAGING_TIP =
  "On: a webhook push builds the hidden <name>-staging sibling with the chosen environment and holds — production is swapped only when you click Promote. Off: pushes redeploy production directly.";

interface WebhooksTabProps {
  app: AppData;
  appId: number;
  webhookForm: { branch: string; path: string; waitForCi: boolean; stagingEnvId: number | null };
  setWebhookForm: (f: { branch: string; path: string; waitForCi: boolean; stagingEnvId: number | null }) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

// The staging control (shown when the webhook is enabled) sits inline with the
// "Wait for CI" toggle. Off = a plain toggle; flipping it on reveals an
// environment picker with accept (✓) / decline (✗). Accept persists the choice
// and the toggle reads on with the env name in grey; decline reverts to off.
// When a sibling has been deployed, a compact promote panel appears below.
function StagingPanel({ app, appId, envs, actionLoading, action, ops }: Omit<WebhooksTabProps, "webhookForm" | "setWebhookForm"> & { envs: EnvironmentData[] }) {
  const [data, setData] = useState<AppStagingResponse | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [draftEnvId, setDraftEnvId] = useState("");

  const load = async () => {
    try {
      setData(await get(`/api/apps/${appId}/staging`));
    } catch (err) {
      showToast(errMessage(err), "error");
    }
  };

  useEffect(() => { load(); }, [appId]);

  const stagingEnvId = data?.staging_environment_id ?? app.webhook_staging_environment_id ?? null;
  const enabled = stagingEnvId != null;
  const selectedName = envs.find((e) => e.id === stagingEnvId)?.name;
  const busy = actionLoading === "toggle-staging";

  const setEnv = (next: number | null) =>
    action("toggle-staging", async () => {
      await post("/api/apps/deploy", {
        app_name: app.name,
        apply_mode: "patch",
        deploy: false,
        webhook_staging_environment_id: next,
      });
      await load();
    });

  const startSelecting = () => {
    setDraftEnvId(envs[0] ? String(envs[0].id) : "");
    setSelecting(true);
  };
  const accept = async () => {
    if (!draftEnvId) return;
    await setEnv(parseInt(draftEnvId, 10));
    setSelecting(false);
  };

  const sibling = data?.sibling ?? null;
  const prodCommit = data?.prod_commit ?? null;
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

  return (
    <>
      <PermissionGate
        permission="apps.deploy"
        appId={appId}
        environmentId={app.environment_id}
        fallback={
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className="text-muted">Deploy to staging first</span>
            <span className={`font-bold ${enabled ? "text-fg" : "text-muted"}`}>{enabled ? (selectedName ?? "On") : "Off"}</span>
          </div>
        }
      >
        {selecting ? (
          <div className="flex items-stretch gap-1.5">
            <div className="flex-1">
              <NeoSelect
                compact
                value={draftEnvId}
                placeholder="Select an environment…"
                options={envs.map((e) => ({ value: String(e.id), label: e.name }))}
                onChange={setDraftEnvId}
              />
            </div>
            <button
              type="button"
              onClick={accept}
              disabled={!draftEnvId || busy}
              title="Enable staging with this environment"
              className="border-2 border-fg bg-accent/20 px-2 flex items-center text-fg hover:bg-accent/30 disabled:opacity-40"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => setSelecting(false)}
              disabled={busy}
              title="Cancel"
              className="border-2 border-fg px-2 flex items-center text-muted hover:bg-alt disabled:opacity-40"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <label className="flex items-center gap-2 text-[10px] font-mono cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => (e.target.checked ? startSelecting() : setEnv(null))}
              className="accent-accent"
            />
            <span className="text-muted">Deploy to staging first</span>
            {enabled && selectedName && <span className="text-muted/70">· {selectedName}</span>}
            <InfoTip text={STAGING_TIP} />
          </label>
        )}
      </PermissionGate>

      {enabled && sibling && (
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
            <div className="flex justify-between"><span className="text-muted">Staging commit</span><span className="text-fg">{sibling.commit ? sibling.commit.slice(0, 7) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted">Production commit</span><span className="text-fg">{prodCommit ? prodCommit.slice(0, 7) : "—"}</span></div>
            {sibling.domain && (
              <div className="flex justify-between">
                <span className="text-muted">Preview</span>
                <a href={`https://${sibling.domain}`} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline">{sibling.domain}</a>
              </div>
            )}
          </div>
          <PermissionGate permission="apps.promote" appId={appId} environmentId={app.environment_id}>
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
        </div>
      )}
    </>
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
      <PermissionGate permission="apps.deploy" appId={appId} environmentId={app.environment_id}>
        {app.webhook_enabled ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[10px] font-mono cursor-pointer">
              <input
                type="checkbox"
                checked={!!app.webhook_wait_for_ci}
                onChange={(e) => action("update-webhook-ci", () => post("/api/apps/deploy", {
                  app_name: app.name,
                  apply_mode: "patch",
                  deploy: false,
                  webhook_wait_for_ci: e.target.checked,
                }))}
                className="accent-accent"
              />
              <span className="text-muted">Wait for CI checks before deploying</span>
            </label>
            <StagingPanel app={app} appId={appId} envs={envs} actionLoading={actionLoading} action={action} ops={ops} />
            <Btn size="xs" variant="danger" loading={actionLoading === "disable-webhook"} onClick={() => action("disable-webhook", () => post("/api/apps/deploy", {
              app_name: app.name,
              apply_mode: "patch",
              deploy: false,
              webhook_enabled: false,
            }))}>
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
            <Field label={<>Deploy to staging first (optional) <InfoTip text={STAGING_TIP} /></>}>
              <NeoSelect
                value={webhookForm.stagingEnvId != null ? String(webhookForm.stagingEnvId) : ""}
                options={[
                  { value: "", label: "Off — deploy production directly" },
                  ...envs.map((e) => ({ value: String(e.id), label: e.name })),
                ]}
                onChange={(v) => setWebhookForm({ ...webhookForm, stagingEnvId: v ? parseInt(v, 10) : null })}
              />
            </Field>
            <Btn size="xs" variant="primary" loading={actionLoading === "enable-webhook"} onClick={() => action("enable-webhook", () => post("/api/apps/deploy", {
              app_name: app.name,
              apply_mode: "patch",
              deploy: false,
              webhook_enabled: true,
              webhook_branch: webhookForm.branch || "main",
              webhook_path: webhookForm.path || "",
              webhook_wait_for_ci: webhookForm.waitForCi,
              webhook_staging_environment_id: webhookForm.stagingEnvId,
            }))}>
              Enable Webhook
            </Btn>
          </div>
        )}
      </PermissionGate>
    </Card>
  );
}
