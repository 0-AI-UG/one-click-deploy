import { useState } from "react";
import { post } from "../api/client.ts";
import { showToast, Spinner, Btn } from "../components/ui.tsx";
import { KeyRound, ArrowRight, Fingerprint, ArrowLeft } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { errMsg } from "../lib/errors.ts";

type Mode = "totp" | "passkey";

export function PasswordResetPage() {
  const [username, setUsername] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("totp");
  const [passkeyDone, setPasskeyDone] = useState(false);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const validatePasswords = (): boolean => {
    if (newPassword !== confirm) {
      showToast("Passwords do not match", "error");
      return false;
    }
    if (newPassword.length < 8) {
      showToast("Password must be at least 8 characters", "error");
      return false;
    }
    return true;
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validatePasswords()) return;
    setLoading(true);
    try {
      await post("/api/auth/password-reset", {
        username,
        totpCode: totpCode.trim(),
        newPassword,
      });
      showToast("Password reset. You can now sign in.", "success");
      window.location.hash = "#/login";
    } catch (err) {
      showToast(errMsg(err) || "Password reset failed", "error");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) {
      showToast("Enter your username first", "error");
      return;
    }
    if (!validatePasswords()) return;
    setLoading(true);
    try {
      const options = await post("/api/auth/password-reset/webauthn-options", { username });
      const credential = await startAuthentication({ optionsJSON: options });
      await post("/api/auth/password-reset/webauthn-verify", {
        username,
        credential,
        newPassword,
      });
      setPasskeyDone(true);
      showToast("Password reset. You can now sign in.", "success");
      window.location.hash = "#/login";
    } catch (err) {
      if ((err instanceof Error && err.name === "NotAllowedError")) {
        showToast("Passkey verification was cancelled.", "error");
      } else {
        showToast(errMsg(err) || "Password reset failed", "error");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <KeyRound size={24} className="text-fg" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Reset Password</h1>
        </div>
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
          {/* Mode switcher */}
          <div className="flex gap-1 mb-4">
            <button
              type="button"
              onClick={() => setMode("totp")}
              className={`flex-1 font-mono text-[9px] font-bold uppercase tracking-wider px-3 py-1.5 border-2 border-fg transition-colors ${
                mode === "totp" ? "bg-accent" : "bg-alt hover:bg-bg-raised"
              }`}
            >
              Code
            </button>
            {supportsWebAuthn && (
              <button
                type="button"
                onClick={() => setMode("passkey")}
                className={`flex-1 font-mono text-[9px] font-bold uppercase tracking-wider px-3 py-1.5 border-2 border-fg transition-colors ${
                  mode === "passkey" ? "bg-accent" : "bg-alt hover:bg-bg-raised"
                }`}
              >
                Passkey
              </button>
            )}
          </div>

          {mode === "totp" && (
            <>
              <p className="text-[10px] text-muted font-mono mb-4 uppercase tracking-wider">
                Enter your username, a current 2FA code (or backup code), and a new password.
              </p>
              <form onSubmit={handleTotpSubmit} className="space-y-4">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required autoFocus />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">2FA code or backup code</label>
                  <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="123456 or ABCD-EFGH" required />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">New password</label>
                  <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Confirm new password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required minLength={8} />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
                >
                  {loading ? <Spinner /> : <><span>Reset Password</span><ArrowRight size={14} /></>}
                </button>
              </form>
            </>
          )}

          {mode === "passkey" && (
            <>
              <p className="text-[10px] text-muted font-mono mb-4 uppercase tracking-wider">
                Enter your username and new password, then verify with your passkey.
              </p>
              <form onSubmit={handlePasskeySubmit} className="space-y-4">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required autoFocus />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">New password</label>
                  <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Confirm new password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required minLength={8} />
                </div>
                <button
                  type="submit"
                  disabled={loading || passkeyDone}
                  className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
                >
                  {loading ? <Spinner /> : <><Fingerprint size={14} /><span>Verify & Reset</span></>}
                </button>
              </form>
            </>
          )}

          <div className="mt-4 text-center">
            <Btn variant="ghost" onClick={() => { window.location.hash = "#/login"; }}><ArrowLeft size={14} /></Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
