import { useState, useRef, useEffect } from "react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, setTempToken } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { Shield, Fingerprint, KeyRound } from "lucide-react";

type Mode = "choose" | "webauthn" | "totp" | "recover";

export function TwoFactorVerifyPage() {
  const { tempToken, token, twoFactorMethods } = useAuth();
  const hasTotp = twoFactorMethods?.totp ?? false;
  const hasWebauthn = twoFactorMethods?.webauthn ?? false;

  const initialMode: Mode = hasWebauthn ? "webauthn" : "totp";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [backupCode, setBackupCode] = useState("");
  const [webauthnError, setWebauthnError] = useState("");
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // Auto-trigger WebAuthn ceremony
  useEffect(() => {
    if (mode === "webauthn" && tempToken && !loading) {
      triggerWebAuthn();
    }
  }, [mode]);

  const triggerWebAuthn = async () => {
    if (!tempToken) return;
    setLoading(true);
    setWebauthnError("");
    try {
      const options = await post("/api/auth/webauthn/login-options", { tempToken });
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/login-verify", { tempToken, credential });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setWebauthnError("Passkey verification was cancelled.");
      } else {
        setWebauthnError(err.message || "Passkey verification failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) refs.current[idx + 1]?.focus();
    if (next.every((d) => d)) submitTotp(next.join(""));
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    }
  };

  const submitTotp = async (code: string) => {
    if (!tempToken) return;
    setLoading(true);
    try {
      const res = await post("/api/auth/totp/login", { tempToken, code });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      showToast(err.message || "Invalid code", "error");
      setDigits(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const submitRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempToken || !backupCode.trim()) return;
    setLoading(true);
    try {
      const res = await post("/api/auth/totp/reset-from-login", {
        tempToken,
        backupCode: backupCode.trim(),
      });
      if (res.token) {
        // User still has webauthn, got a real JWT
        login(res.token, res.user);
        window.location.hash = "#/";
      } else {
        // No 2FA left, force re-enrollment
        setTempToken(res.tempToken);
        showToast("2FA reset. Please set up a new method.", "success");
        window.location.hash = "#/2fa-setup";
      }
    } catch (err: any) {
      showToast(err.message || "Invalid backup code", "error");
    } finally {
      setLoading(false);
    }
  };

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up text-center">
        <Shield size={32} className="text-fg mx-auto mb-4" />
        <h2 className="font-mono font-bold text-sm text-fg uppercase mb-1">Two-Factor Authentication</h2>
        <p className="text-[10px] text-muted mb-6 font-mono uppercase tracking-wider">
          {mode === "webauthn" && "Verify with your passkey"}
          {mode === "totp" && "Enter the 6-digit code from your authenticator app"}
          {mode === "recover" && "Enter a backup code to reset 2FA"}
        </p>

        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
          {mode === "webauthn" && (
            <>
              <div className="flex flex-col items-center gap-4 mb-4">
                <Fingerprint size={48} className="text-fg" />
                {loading ? (
                  <Spinner />
                ) : (
                  <>
                    {webauthnError && (
                      <p className="text-[10px] text-red-500 font-mono">{webauthnError}</p>
                    )}
                    <button
                      onClick={triggerWebAuthn}
                      className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all"
                    >
                      <Fingerprint size={14} /> Try Again
                    </button>
                  </>
                )}
              </div>
              {hasTotp && (
                <button
                  type="button"
                  onClick={() => setMode("totp")}
                  className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
                >
                  Use authenticator app instead
                </button>
              )}
            </>
          )}

          {mode === "totp" && (
            <>
              <div className="flex gap-2 justify-center mb-4">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => { refs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    onChange={(e) => handleChange(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    autoFocus={i === 0}
                    className="!w-11 !h-12 text-center text-lg font-mono font-bold !px-0"
                  />
                ))}
              </div>
              {loading && <div className="flex justify-center"><Spinner /></div>}
              <p className="text-[9px] text-muted font-mono mt-3 uppercase tracking-wider">You can also use a backup code</p>
              {hasWebauthn && (
                <button
                  type="button"
                  onClick={() => setMode("webauthn")}
                  className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
                >
                  Use passkey instead
                </button>
              )}
            </>
          )}

          {mode === "recover" && (
            <form onSubmit={submitRecover} className="space-y-3">
              <input
                type="text"
                value={backupCode}
                onChange={(e) => setBackupCode(e.target.value)}
                placeholder="ABCD-EFGH"
                autoFocus
                className="w-full text-center font-mono"
              />
              <button
                type="submit"
                disabled={loading || !backupCode.trim()}
                className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
              >
                {loading ? <Spinner /> : <span>Reset 2FA</span>}
              </button>
              <p className="text-[9px] text-muted font-mono uppercase tracking-wider">
                This disables your current authenticator and may require you to set up a new 2FA method.
              </p>
            </form>
          )}

          {mode !== "recover" && (
            <button
              type="button"
              onClick={() => setMode("recover")}
              className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
            >
              Lost your device? Use a backup code
            </button>
          )}
          {mode === "recover" && (
            <button
              type="button"
              onClick={() => setMode(hasWebauthn ? "webauthn" : "totp")}
              className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
            >
              Back to verification
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
