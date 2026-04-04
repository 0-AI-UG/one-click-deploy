import { useState, useRef } from "react";
import { post } from "../api/client.ts";
import { useAuth, login } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { Shield } from "lucide-react";

export function TotpVerifyPage() {
  const { tempToken, token } = useAuth();
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) refs.current[idx + 1]?.focus();
    if (next.every((d) => d)) submit(next.join(""));
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    }
  };

  const submit = async (code: string) => {
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

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up text-center">
        <Shield size={32} className="text-fg mx-auto mb-4" />
        <h2 className="font-mono font-bold text-sm text-fg uppercase mb-1">Two-Factor Authentication</h2>
        <p className="text-[10px] text-muted mb-6 font-mono uppercase tracking-wider">Enter the 6-digit code from your authenticator app</p>
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
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
        </div>
      </div>
    </div>
  );
}
