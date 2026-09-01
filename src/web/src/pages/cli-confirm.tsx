import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { showToast, Card, Btn, AuthShell, PageState } from "../components/ui.tsx";
import { Trash2, Check, AlertTriangle, Ban } from "lucide-react";

type Item = {
  action: string;
  summary: string;
  resource_type: string;
  resource_id: string;
  resource_name?: string;
};

const ACTION_PRESENTATION: Record<string, { confirmLabel: string; destructive: boolean }> = {
  delete_app: { confirmLabel: "Confirm & Destroy", destructive: true },
  delete_server: { confirmLabel: "Confirm & Remove", destructive: true },
  delete_stack: { confirmLabel: "Confirm & Destroy", destructive: true },
  delete_environment: { confirmLabel: "Confirm & Retire", destructive: true },
  purge_environment: { confirmLabel: "Confirm & Delete", destructive: true },
  delete_volume: { confirmLabel: "Confirm & Delete", destructive: true },
  create_bucket: { confirmLabel: "Confirm & Create", destructive: false },
  delete_bucket: { confirmLabel: "Confirm & Delete", destructive: true },
  cancel_operation: { confirmLabel: "Confirm & Cancel", destructive: true },
  create_server: { confirmLabel: "Confirm & Create", destructive: false },
  promote_app: { confirmLabel: "Confirm & Promote", destructive: false },
  promote_stack: { confirmLabel: "Confirm & Promote", destructive: false },
};

export function CliConfirmPage({ userCode }: { userCode: string }) {
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "confirm" | "deny">(null);
  const [done, setDone] = useState<null | "confirmed" | "denied">(null);
  const [typedResource, setTypedResource] = useState("");

  useEffect(() => {
    get(`/api/confirmations/item/${encodeURIComponent(userCode)}`)
      .then((res: Item) => setItem(res))
      .catch(() => setError("This confirmation link is invalid or has expired."));
  }, [userCode]);

  const handleConfirm = async () => {
    setSubmitting("confirm");
    try {
      await post(
        `/api/confirmations/item/${encodeURIComponent(userCode)}/confirm`,
        item?.action === "delete_volume"
          ? { typed_resource_id: typedResource.trim() }
          : item?.action === "purge_environment" || item?.action === "delete_bucket"
            ? { typed_resource_name: typedResource.trim() }
          : undefined,
      );
      setDone("confirmed");
    } catch (err: any) {
      showToast(err.message || "Failed to confirm action", "error");
    } finally {
      setSubmitting(null);
    }
  };

  const handleDeny = async () => {
    setSubmitting("deny");
    try {
      await post(`/api/confirmations/item/${encodeURIComponent(userCode)}/deny`);
      setDone("denied");
    } catch (err: any) {
      showToast(err.message || "Failed to cancel action", "error");
    } finally {
      setSubmitting(null);
    }
  };

  // --- done: confirmed ---
  if (done === "confirmed") {
    return (
      <AuthShell icon={<Check size={32} />} title="Action Confirmed">
          <Card className="p-8 text-center">
            <p className="font-mono text-[11px] text-muted">You can close this page and return to your terminal.</p>
          </Card>
      </AuthShell>
    );
  }

  // --- done: denied ---
  if (done === "denied") {
    return (
      <AuthShell icon={<Ban size={32} />} title="Action Cancelled">
          <Card className="p-8 text-center">
            <p className="font-mono text-[11px] text-muted">The action was cancelled. You can close this page.</p>
          </Card>
      </AuthShell>
    );
  }

  // --- error ---
  if (error) {
    return (
      <AuthShell icon={<AlertTriangle size={32} className="text-accent-red" />} title="Confirmation Unavailable">
          <Card className="border-accent-red p-8 text-center">
            <p className="font-mono text-[11px] text-muted">{error}</p>
          </Card>
      </AuthShell>
    );
  }

  // --- loading ---
  if (!item) {
    return <PageState title="Loading confirmation" />;
  }

  // --- loaded (pending) ---
  const requiredTypedResource = item.action === "delete_volume"
    ? item.resource_id
    : item.action === "purge_environment" || item.action === "delete_bucket"
      ? item.resource_name
      : undefined;
  const typedResourceMatches = requiredTypedResource === undefined || typedResource.trim() === requiredTypedResource;
  const presentation = ACTION_PRESENTATION[item.action] ?? {
    confirmLabel: "Confirm Action",
    destructive: false,
  };
  const ConfirmationIcon = presentation.destructive ? Trash2 : Check;

  return (
    <AuthShell icon={<ConfirmationIcon size={24} />} title="Confirm Action">
        <Card className="p-6">
          <p className="font-mono text-[11px] text-muted mb-4">
            A CLI command is requesting confirmation{presentation.destructive ? " for a destructive action" : ""}. Review the details below before continuing.
          </p>
          <div className="border-2 border-fg bg-bg p-3 mb-5">
            <p className="font-mono text-xs text-fg break-words">{item.summary}</p>
          </div>
          {requiredTypedResource !== undefined && (
            <div className="mb-5">
              <label className="block font-mono text-[10px] font-bold text-fg mb-2" htmlFor="resource-confirmation">
                Type {item.action === "delete_volume" ? "volume ID" : item.action === "delete_bucket" ? "bucket name" : "environment name"}{" "}
                <span className="select-all">{requiredTypedResource}</span> to permanently delete it
              </label>
              <input
                id="resource-confirmation"
                type="text"
                value={typedResource}
                onChange={(event) => setTypedResource(event.target.value)}
                autoComplete="off"
                className="w-full border-2 border-fg bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:shadow-neo-sm"
              />
            </div>
          )}
          <div className="space-y-2">
            <Btn
              type="button"
              onClick={handleConfirm}
              variant={presentation.destructive ? "danger" : "primary"}
              size="md"
              loading={submitting === "confirm"}
              disabled={submitting !== null || !typedResourceMatches}
              className="w-full justify-center"
            >
              {presentation.confirmLabel}
            </Btn>
            <Btn
              type="button"
              onClick={handleDeny}
              variant="ghost"
              size="md"
              loading={submitting === "deny"}
              disabled={submitting !== null}
              className="w-full justify-center"
            >
              Cancel
            </Btn>
          </div>
        </Card>
    </AuthShell>
  );
}
