import { useState, useEffect } from "react";
import { patch, post, del } from "../../api/client.ts";
import { Card, Btn, Field, showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { InfoTip } from "../app-detail/shared.tsx";
import { Boxes, GitBranch, Layers, RefreshCw, Trash2 } from "lucide-react";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { StackDetail, StackMemberApp, EnvironmentData } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Stack settings, laid out like the app's: one short label per row, the
 * explanation behind an InfoTip, the control on the right. The prose that used
 * to sit under every row explained the stack model rather than the setting, and
 * made a page with three real controls read like documentation.
 */
export function StackSettingsTab({
  stack,
  memberApps,
  environments,
  reload,
  action,
  actionLoading,
  ops,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
  environments: EnvironmentData[];
  reload: () => void;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  actionLoading: string | null;
  ops: ResourceOpsResult;
}) {
  const [stagingEnvId, setStagingEnvId] = useState<string>(
    stack.staging_environment_id != null ? String(stack.staging_environment_id) : "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStagingEnvId(stack.staging_environment_id != null ? String(stack.staging_environment_id) : "");
  }, [stack.staging_environment_id]);

  const prodEnv = environments.find((e) => e.id === stack.environment_id);
  const onStaging = memberApps.filter((a) => (a.webhook_staging_environment_id ?? null) != null).length;
  const repo = memberApps.find((a) => a.git_repo)?.git_repo;
  const dirty = stagingEnvId !== (stack.staging_environment_id != null ? String(stack.staging_environment_id) : "");

  const saveStagingEnv = async () => {
    const next = stagingEnvId ? parseInt(stagingEnvId, 10) : null;
    if (next == null && onStaging > 0) {
      if (!(await confirm(
        "Clear Staging Environment",
        `This turns webhook staging OFF for ${onStaging} member(s) — pushes will deploy straight to production. Continue?`,
        true,
      ))) return;
    }
    setSaving(true);
    try {
      const res = await patch(`/api/stacks/${stack.id}`, { staging_environment_id: next }) as { members_updated?: number };
      showToast(
        next == null
          ? `Staging disabled on ${res.members_updated ?? 0} member(s)`
          : `Staging environment updated (${res.members_updated ?? 0} member(s) re-pointed)`,
        "success",
      );
      reload();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <Field
          label={<span className="flex items-center gap-2"><Boxes size={14} className="text-fg" /> Stack Name <InfoTip text="Fixed. The name prefixes every member's app, service and container name, and keys the stack's operations." /></span>}
        >
          <input type="text" value={stack.name} readOnly disabled />
        </Field>

        <Field
          label={<span className="flex items-center gap-2"><Layers size={14} className="text-fg" /> Environment <InfoTip text="The shared environment every member deploys with; editing its variables redeploys the whole stack. Fixed for the life of the stack — change it by re-deploying against a different environment." /></span>}
        >
          <div className="flex gap-2 items-center">
            <input type="text" value={prodEnv?.name ?? (stack.environment_id != null ? `#${stack.environment_id}` : "none")} readOnly disabled />
            <Btn size="sm" onClick={() => { window.location.hash = "#/environments"; }}>Edit vars</Btn>
          </div>
        </Field>

        <Field
          label={<span className="flex items-center gap-2"><GitBranch size={14} className="text-fg" /> Staging Environment <InfoTip text="Where members with webhook staging on build their <name>-staging sibling. Re-pointing applies on their next push. A member that never opted in stays off — the opt-in is webhook.staging in the manifest, so turning it on needs a re-sync." /></span>}
          hint={onStaging === 0 ? "no member has staging on" : `applies to ${onStaging} of ${memberApps.length} members`}
        >
          <NeoSelect
            value={stagingEnvId}
            onChange={setStagingEnvId}
            options={[
              { value: "", label: "None — straight to production" },
              ...environments
                .filter((e) => e.id !== stack.environment_id)
                .map((e) => ({ value: String(e.id), label: e.name })),
            ]}
          />
        </Field>

        <PermissionGate permission="stacks.deploy">
          <div className="flex justify-end mt-3">
            <Btn size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={saveStagingEnv}>
              Save
            </Btn>
          </div>
        </PermissionGate>
      </Card>

      <Card className="p-4">
        <Field
          label={<span className="flex items-center gap-2"><RefreshCw size={14} className="text-fg" /> Re-sync from manifest <InfoTip text="Members, per-member resources, ports and needs ordering are declarative: edit ocd-stack.json, then re-deploy. The deploy page applies the diff in place — members you dropped from the manifest are left running, not destroyed." /></span>}
          hint={repo || undefined}
        >
          <div className="flex justify-end">
            <PermissionGate permission="stacks.deploy">
              <Btn
                size="sm"
                variant="primary"
                disabled={ops.isBusy}
                onClick={() => {
                  window.location.hash = repo ? `#/deploy?repo=${encodeURIComponent(repo)}` : "#/deploy";
                }}
              ><RefreshCw size={12} /> Open deploy page</Btn>
            </PermissionGate>
          </div>
        </Field>

        <Field
          label={<span className="flex items-center gap-2"><RefreshCw size={14} className="text-fg" /> Redeploy all members <InfoTip text="Rebuilds every member from its current branch HEAD with the stack's environment, without re-reading the manifest." /></span>}
        >
          <div className="flex justify-end">
            <PermissionGate permission="stacks.deploy">
              <Btn
                size="sm"
                disabled={ops.isBusy}
                loading={actionLoading === "redeploy" || ops.isBusyWith("cascade_redeploy")}
                onClick={() => action("redeploy", () => post(`/api/stacks/${stack.id}/redeploy`))}
              ><RefreshCw size={12} /> Redeploy stack</Btn>
            </PermissionGate>
          </div>
        </Field>
      </Card>

      <Card className="p-4">
        <h3 className="font-mono text-[9px] text-accent-red font-bold uppercase tracking-wider mb-1">Danger Zone</h3>
        <Field
          label={<span className="flex items-center gap-2"><Trash2 size={14} className="text-accent-red" /> Destroy stack <InfoTip text="Removes every member's containers, volumes and data. Not reversible." /></span>}
          hint={`${memberApps.length} app(s) · ${stack.services.length} service(s)`}
        >
          <div className="flex justify-end">
            <PermissionGate permission="stacks.destroy">
              <Btn
                size="sm"
                variant="danger"
                disabled={ops.isBusy}
                loading={actionLoading === "destroy" || ops.isBusyWith("destroy_stack")}
                onClick={async () => {
                  if (await confirm(
                    "Destroy Stack",
                    `Permanently destroy "${stack.name}" and all ${memberApps.length} app(s) and ${stack.services.length} service(s)? This removes every member's containers, volumes, and data.`,
                    true,
                  )) {
                    await action("destroy", () => del(`/api/stacks/${stack.id}`));
                    window.location.hash = "#/";
                  }
                }}
              ><Trash2 size={12} /> Destroy stack</Btn>
            </PermissionGate>
          </div>
        </Field>
      </Card>
    </div>
  );
}
