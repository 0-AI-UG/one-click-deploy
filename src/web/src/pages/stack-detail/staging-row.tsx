import { useState } from "react";
import { patch } from "../../api/client.ts";
import { showToast, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { InfoTip } from "../app-detail/shared.tsx";
import { Check, X } from "lucide-react";
import type { StackDetail, StackMemberApp, EnvironmentData } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const TIP =
  "Where members with webhook staging on build their <name>-staging sibling. Re-pointing applies on their next push. A member that never opted in stays off — the opt-in is webhook.staging in the manifest, so turning it on needs a re-sync.";

/**
 * The stack's staging environment, using the same inline control as an app's
 * "Deploy to staging first": a checkbox that, when flipped on, reveals an
 * environment picker with accept (✓) / decline (✗). One control instead of a
 * select plus a separate Save button on a settings page of its own.
 */
export function StackStagingRow({
  stack,
  memberApps,
  environments,
  reload,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
  environments: EnvironmentData[];
  reload: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [draftEnvId, setDraftEnvId] = useState("");
  const [busy, setBusy] = useState(false);

  const enabled = stack.staging_environment_id != null;
  const selectedName = environments.find((e) => e.id === stack.staging_environment_id)?.name;
  const onStaging = memberApps.filter((a) => (a.webhook_staging_environment_id ?? null) != null).length;
  // The production environment can't double as the staging one.
  const choices = environments.filter((e) => e.id !== stack.environment_id);

  const setEnv = async (next: number | null) => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  const clear = async () => {
    if (onStaging > 0 && !(await confirm(
      "Clear Staging Environment",
      `This turns webhook staging OFF for ${onStaging} member(s) — pushes will deploy straight to production. Continue?`,
      true,
    ))) return;
    await setEnv(null);
  };

  return (
    <div className="flex justify-between gap-4 items-center min-h-[1.5rem]">
      <span className="text-muted shrink-0">Staging Environment</span>
      <PermissionGate
        permission="stacks.settings"
        environmentId={stack.environment_id}
        fallback={
          <span className={enabled ? "text-fg font-bold" : "text-fg-dim"}>{selectedName ?? "none"}</span>
        }
      >
        {selecting ? (
          <span className="flex items-stretch gap-1.5 flex-1 max-w-[16rem]">
            <span className="flex-1">
              <NeoSelect
                compact
                value={draftEnvId}
                placeholder="Select an environment…"
                options={choices.map((e) => ({ value: String(e.id), label: e.name }))}
                onChange={setDraftEnvId}
              />
            </span>
            <button
              type="button"
              onClick={async () => {
                if (!draftEnvId) return;
                await setEnv(parseInt(draftEnvId, 10));
                setSelecting(false);
              }}
              disabled={!draftEnvId || busy}
              title="Use this staging environment"
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
          </span>
        ) : (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || choices.length === 0}
              onChange={(e) => {
                if (!e.target.checked) return void clear();
                setDraftEnvId(choices[0] ? String(choices[0].id) : "");
                setSelecting(true);
              }}
              className="accent-accent"
            />
            <span className={enabled ? "text-fg font-bold" : "text-muted"}>
              {enabled ? (selectedName ?? "on") : "none"}
            </span>
            {enabled && onStaging > 0 && (
              <span className="text-muted/70">· {onStaging}/{memberApps.length} members</span>
            )}
            <InfoTip text={TIP} />
          </label>
        )}
      </PermissionGate>
    </div>
  );
}
