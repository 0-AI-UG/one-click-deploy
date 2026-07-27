import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { Trash2, Check, AlertTriangle, Ban } from "lucide-react";

type Item = {
  action: string;
  summary: string;
  resource_type: string;
  resource_id: string;
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
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm animate-slide-up text-center">
          <div className="bg-bg-raised border-2 border-fg shadow-neo p-8">
            <Check size={32} className="text-green-600 mx-auto mb-4" />
            <h2 className="font-mono text-sm font-bold text-fg uppercase mb-2">Action Confirmed</h2>
            <p className="font-mono text-[11px] text-muted">You can close this page and return to your terminal.</p>
          </div>
        </div>
      </div>
    );
  }

  // --- done: denied ---
  if (done === "denied") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm animate-slide-up text-center">
          <div className="bg-bg-raised border-2 border-fg shadow-neo p-8">
            <Ban size={32} className="text-fg mx-auto mb-4" />
            <h2 className="font-mono text-sm font-bold text-fg uppercase mb-2">Action Cancelled</h2>
            <p className="font-mono text-[11px] text-muted">The action was cancelled. You can close this page.</p>
          </div>
        </div>
      </div>
    );
  }

  // --- error ---
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm animate-slide-up text-center">
          <div className="bg-bg-raised border-2 border-accent-red shadow-neo p-8">
            <AlertTriangle size={32} className="text-accent-red mx-auto mb-4" />
            <h2 className="font-mono text-sm font-bold text-fg uppercase mb-2">Confirmation Unavailable</h2>
            <p className="font-mono text-[11px] text-muted">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // --- loading ---
  if (!item) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Spinner />
      </div>
    );
  }

  // --- loaded (pending) ---
  const requiresTypedVolume = item.action === "delete_volume";
  const typedVolumeMatches = !requiresTypedVolume || typedResource.trim() === item.resource_id;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <Trash2 size={24} className="text-fg" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Confirm Action</h1>
        </div>
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
          <p className="font-mono text-[11px] text-muted mb-4">
            A CLI command is requesting confirmation for a destructive action. Review the details below before continuing.
          </p>
          <div className="border-2 border-fg bg-bg p-3 mb-5">
            <p className="font-mono text-xs text-fg break-words">{item.summary}</p>
          </div>
          {requiresTypedVolume && (
            <div className="mb-5">
              <label className="block font-mono text-[10px] font-bold text-fg mb-2" htmlFor="volume-confirmation">
                Type volume ID <span className="select-all">{item.resource_id}</span> to permanently delete it
              </label>
              <input
                id="volume-confirmation"
                type="text"
                value={typedResource}
                onChange={(event) => setTypedResource(event.target.value)}
                autoComplete="off"
                className="w-full border-2 border-fg bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:shadow-neo-sm"
              />
            </div>
          )}
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting !== null || !typedVolumeMatches}
              className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
            >
              {submitting === "confirm" ? <Spinner /> : "Confirm & Delete"}
            </button>
            <button
              type="button"
              onClick={handleDeny}
              disabled={submitting !== null}
              className="w-full flex items-center justify-center gap-2 bg-bg-raised text-fg-dim border-2 border-fg shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
            >
              {submitting === "deny" ? <Spinner /> : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
