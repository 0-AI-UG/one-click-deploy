import { useState } from "react";
import { post } from "../api/client.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { KeyRound, ArrowRight } from "lucide-react";

export function PasswordResetPage() {
  const [email, setEmail] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      showToast("Passwords do not match", "error");
      return;
    }
    if (newPassword.length < 8) {
      showToast("Password must be at least 8 characters", "error");
      return;
    }
    setLoading(true);
    try {
      await post("/api/auth/password-reset", {
        email,
        totpCode: totpCode.trim(),
        newPassword,
      });
      showToast("Password reset. You can now sign in.", "success");
      window.location.hash = "#/login";
    } catch (err: any) {
      showToast(err.message || "Password reset failed", "error");
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
          <p className="text-[10px] text-muted font-mono mb-4 uppercase tracking-wider">
            Enter your email, a current 2FA code (or backup code), and a new password.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
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
          <div className="mt-4 text-center">
            <a
              href="#/login"
              className="font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg"
            >
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
