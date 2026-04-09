import { useState, useEffect, useRef } from "react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login } from "../stores/auth.ts";
import { showToast, Spinner, Card } from "../components/ui.tsx";
import { QrCode, Fingerprint, Copy, Check, ArrowRight, Shield } from "lucide-react";

type Step = "choose" | "totp-qr" | "passkey-register" | "backup";

export function TwoFactorSetupPage() {
  const { tempToken, token } = useAuth();
  const [step, setStep] = useState<Step>("choose");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const supportsWebAuthn = browserSupportsWebAuthn();

  // TOTP state
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Passkey state
  const [passkeyError, setPasskeyError] = useState("");

  // If only one method is available, skip the choice screen
  useEffect(() => {
    if (!supportsWebAuthn && step === "choose") {
      startTotpSetup();
    }
  }, []);

  const startTotpSetup = async () => {
    if (!tempToken) return;
    setStep("totp-qr");
    try {
      const res = await post("/api/auth/totp/setup-from-login", { tempToken });
      setQrCode(res.qrCode);
      setSecret(res.secret);
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const startPasskeySetup = async () => {
    if (!tempToken) return;
    setStep("passkey-register");
    setPasskeyError("");
    setLoading(true);
    try {
      const options = await post("/api/auth/webauthn/register-options-from-login", { tempToken });
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify-from-login", { tempToken, credential });
      setBackupCodes(res.backupCodes);
      login(res.token, res.user);
      setStep("backup");
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setPasskeyError("Passkey registration was cancelled.");
      } else {
        setPasskeyError(err.message || "Passkey registration failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDigitChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) digitRefs.current[idx + 1]?.focus();
    if (next.every((d) => d)) confirmTotpCode(next.join(""));
  };

  const handleDigitKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      digitRefs.current[idx - 1]?.focus();
    }
  };

  const confirmTotpCode = async (code: string) => {
    if (!tempToken) return;
    setLoading(true);
    try {
      const res = await post("/api/auth/totp/confirm-from-login", { tempToken, code });
      setBackupCodes(res.backupCodes);
      login(res.token, res.user);
      setStep("backup");
    } catch (err: any) {
      showToast(err.message || "Invalid code", "error");
      setDigits(["", "", "", "", "", ""]);
      digitRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md animate-slide-up">
        <div className="text-center mb-6">
          <Shield size={32} className="text-fg mx-auto mb-3" />
          <h2 className="font-mono font-bold text-sm text-fg uppercase">Set Up Two-Factor Authentication</h2>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Required for account security</p>
        </div>

        {step === "choose" && (
          <div className="space-y-3">
            {supportsWebAuthn && (
              <button
                onClick={startPasskeySetup}
                className="w-full bg-bg-raised border-2 border-fg shadow-neo p-5 text-left hover:shadow-neo-lg hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none transition-all"
              >
                <div className="flex items-center gap-3">
                  <Fingerprint size={24} className="text-fg flex-shrink-0" />
                  <div>
                    <div className="font-mono text-[11px] font-bold text-fg uppercase">Passkey</div>
                    <div className="font-mono text-[9px] text-muted mt-0.5 uppercase tracking-wider">
                      Use Touch ID, Face ID, or a security key
                    </div>
                  </div>
                </div>
              </button>
            )}
            <button
              onClick={startTotpSetup}
              className="w-full bg-bg-raised border-2 border-fg shadow-neo p-5 text-left hover:shadow-neo-lg hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none transition-all"
            >
              <div className="flex items-center gap-3">
                <QrCode size={24} className="text-fg flex-shrink-0" />
                <div>
                  <div className="font-mono text-[11px] font-bold text-fg uppercase">Authenticator App</div>
                  <div className="font-mono text-[9px] text-muted mt-0.5 uppercase tracking-wider">
                    Use Google Authenticator, Authy, or similar
                  </div>
                </div>
              </div>
            </button>
          </div>
        )}

        {step === "totp-qr" && (
          <Card className="p-6">
            <div className="text-center mb-5">
              <p className="text-[10px] text-muted font-mono mb-4 uppercase tracking-wider">Scan this QR code with your authenticator app</p>
              {qrCode ? (
                <img src={qrCode} alt="TOTP QR Code" className="mx-auto w-48 h-48 border-2 border-fg bg-white p-2" />
              ) : (
                <div className="w-48 h-48 mx-auto bg-alt border-2 border-fg flex items-center justify-center">
                  <Spinner />
                </div>
              )}
            </div>

            {secret && (
              <div className="mb-5">
                <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg mb-1">Or enter manually</p>
                <div className="flex items-center gap-2 bg-alt border-2 border-fg px-3 py-2">
                  <code className="text-[10px] font-mono text-fg font-bold flex-1 break-all">{secret}</code>
                  <button onClick={copySecret} className="text-muted hover:text-fg transition-colors flex-shrink-0">
                    {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            )}

            <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg mb-2">Enter verification code</p>
            <div className="flex gap-2 justify-center mb-3">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => { digitRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(i, e)}
                  autoFocus={i === 0}
                  className="!w-10 !h-11 text-center text-base font-mono font-bold !px-0"
                />
              ))}
            </div>
            {loading && <div className="flex justify-center"><Spinner /></div>}

            {supportsWebAuthn && (
              <button
                type="button"
                onClick={() => { setStep("choose"); setQrCode(""); setSecret(""); setDigits(["","","","","",""]); }}
                className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline block mx-auto"
              >
                Choose a different method
              </button>
            )}
          </Card>
        )}

        {step === "passkey-register" && (
          <Card className="p-6 text-center">
            <Fingerprint size={48} className="text-fg mx-auto mb-4" />
            {loading ? (
              <>
                <p className="text-[10px] text-muted font-mono uppercase tracking-wider mb-4">
                  Follow your browser's prompt to register a passkey...
                </p>
                <Spinner />
              </>
            ) : (
              <>
                {passkeyError && (
                  <p className="text-[10px] text-red-500 font-mono mb-4">{passkeyError}</p>
                )}
                <button
                  onClick={startPasskeySetup}
                  className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all mb-3"
                >
                  <Fingerprint size={14} /> Try Again
                </button>
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  className="font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
                >
                  Choose a different method
                </button>
              </>
            )}
          </Card>
        )}

        {step === "backup" && (
          <Card className="p-6">
            <h3 className="font-mono font-bold text-sm text-fg uppercase mb-2">Backup Codes</h3>
            <p className="text-[10px] text-muted font-mono mb-4">
              Save these codes securely. Each can be used once to sign in if you lose access to your 2FA method.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {backupCodes.map((code) => (
                <div key={code} className="bg-alt border-2 border-fg px-3 py-2 text-center">
                  <code className="font-mono text-[10px] text-fg font-bold tracking-wider">{code}</code>
                </div>
              ))}
            </div>
            <button
              onClick={() => { window.location.hash = "#/"; }}
              className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all"
            >
              <span>Continue to Dashboard</span>
              <ArrowRight size={14} />
            </button>
          </Card>
        )}
      </div>
    </div>
  );
}
