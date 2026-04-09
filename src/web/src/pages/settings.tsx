import { useState, useEffect } from "react";
import { get, post, put } from "../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../components/ui.tsx";
import { User, Shield, Fingerprint, KeyRound, Lock, Trash2 } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

type PasskeyInfo = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string };

function SecuritySection() {
  const [status, setStatus] = useState<any>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const refresh = () => {
    Promise.all([
      get("/api/auth/totp/status"),
      get("/api/auth/webauthn/credentials"),
    ]).then(([s, p]) => {
      setStatus(s);
      setPasskeys(p);
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const addPasskey = async () => {
    setBusy(true);
    try {
      const options = await post("/api/auth/webauthn/register-options");
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify", { credential });
      if (res.backupCodes) {
        showToast(`Passkey added. Save your backup codes: ${res.backupCodes.join(", ")}`, "success");
      } else {
        showToast("Passkey added", "success");
      }
      refresh();
    } catch (err: any) {
      if (err.name !== "NotAllowedError") {
        showToast(err.message || "Failed to add passkey", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const deletePasskey = async (id: string, name: string) => {
    if (!confirm(`Remove passkey "${name}"?`)) return;
    setBusy(true);
    try {
      await post("/api/auth/webauthn/delete", { credentialId: id });
      showToast("Passkey removed", "success");
      refresh();
    } catch (err: any) {
      showToast(err.message || "Failed to remove passkey", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="p-5 mt-6"><div className="flex justify-center"><Spinner /></div></Card>;
  if (!status) return null;

  return (
    <Card className="p-5 space-y-4 mt-6">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Security</h3>
      </div>

      {/* TOTP Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-muted" />
          <span className="font-mono text-[11px] text-fg font-bold">Authenticator App</span>
        </div>
        <span className={`font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg ${status.enabled ? "bg-green-200" : "bg-alt"}`}>
          {status.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {/* Passkeys */}
      <div className="border-t-2 border-fg pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Fingerprint size={14} className="text-muted" />
            <span className="font-mono text-[11px] text-fg font-bold">Passkeys</span>
          </div>
          {supportsWebAuthn && (
            <Btn size="xs" loading={busy} onClick={addPasskey}>
              + Add Passkey
            </Btn>
          )}
        </div>
        {passkeys.length === 0 ? (
          <p className="font-mono text-[10px] text-muted">No passkeys registered.</p>
        ) : (
          <div className="space-y-1">
            {passkeys.map((pk) => (
              <div key={pk.id} className="flex items-center justify-between bg-alt border-2 border-fg px-3 py-2">
                <div>
                  <span className="font-mono text-[10px] text-fg font-bold">{pk.name}</span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {pk.backedUp ? "Synced" : pk.deviceType === "singleDevice" ? "Device-bound" : ""}
                  </span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {new Date(pk.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  onClick={() => deletePasskey(pk.id, pk.name)}
                  disabled={busy}
                  className="text-muted hover:text-red-500 transition-colors disabled:opacity-35"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!supportsWebAuthn && (
          <p className="font-mono text-[9px] text-muted mt-1">Your browser does not support passkeys.</p>
        )}
      </div>

      {/* Backup codes */}
      {(status.enabled || status.webauthnEnabled) && (
        <div className="border-t-2 border-fg pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-fg font-bold">Backup Codes</span>
            <span className="font-mono text-[10px] text-muted">{status.backupCodesRemaining} remaining</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const changeMyPassword = async () => {
    if (!currentPassword) return showToast("Current password is required", "error");
    if (!newPassword || newPassword.length < 8) return showToast("New password must be at least 8 characters", "error");
    if (!totpCode) return showToast("2FA code is required", "error");
    setSavingPassword(true);
    try {
      await put("/api/me", { currentPassword, newPassword, totpCode });
      showToast("Password changed", "success");
      setCurrentPassword("");
      setNewPassword("");
      setTotpCode("");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-6">
        <User size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Account</h1>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Lock size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Change My Password</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Current Password</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 characters" />
          </div>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">2FA Code</label>
            <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="6-digit code" maxLength={6} inputMode="numeric" />
          </div>
        </div>
        <div className="mt-3">
          <Btn variant="default" loading={savingPassword} onClick={changeMyPassword}>Change Password</Btn>
        </div>
      </Card>

      <SecuritySection />
    </div>
  );
}
