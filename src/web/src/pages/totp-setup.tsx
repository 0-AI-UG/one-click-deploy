import { useState, useEffect, useRef } from "react";
import { post } from "../api/client.ts";
import { useAuth, login } from "../stores/auth.ts";
import { showToast, Spinner, Card } from "../components/ui.tsx";
import { QrCode, Copy, Check, ArrowRight } from "lucide-react";
import { errMsg } from "../lib/errors.ts";

export function TotpSetupPage() {
  const { tempToken, token } = useAuth();
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"qr" | "backup">("qr");
  const [copied, setCopied] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!tempToken) return;
    post("/api/auth/totp/setup-from-login", { tempToken }).then((res) => {
      setQrCode(res.qrCode);
      setSecret(res.secret);
    }).catch((err) => showToast(errMsg(err), "error"));
  }, [tempToken]);

  const handleChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) refs.current[idx + 1]?.focus();
    if (next.every((d) => d)) confirmCode(next.join(""));
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    }
  };

  const confirmCode = async (code: string) => {
    if (!tempToken) return;
    setLoading(true);
    try {
      const res = await post("/api/auth/totp/confirm-from-login", { tempToken, code });
      setBackupCodes(res.backupCodes);
      login(res.token, res.user);
      setStep("backup");
    } catch (err) {
      showToast(errMsg(err) || "Invalid code", "error");
      setDigits(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
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
          <QrCode size={32} className="text-fg mx-auto mb-3" />
          <h2 className="font-mono font-bold text-sm text-fg uppercase">Set Up Two-Factor Authentication</h2>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Required for account security</p>
        </div>

        {step === "qr" && (
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
                  ref={(el) => { refs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  autoFocus={i === 0}
                  className="!w-10 !h-11 text-center text-base font-mono font-bold !px-0"
                />
              ))}
            </div>
            {loading && <div className="flex justify-center"><Spinner /></div>}
          </Card>
        )}

        {step === "backup" && (
          <Card className="p-6">
            <h3 className="font-mono font-bold text-sm text-fg uppercase mb-2">Backup Codes</h3>
            <p className="text-[10px] text-muted font-mono mb-4">
              Save these codes securely. Each can be used once to sign in if you lose your authenticator.
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
