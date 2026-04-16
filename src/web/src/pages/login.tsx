import { useState } from "react";
import { post } from "../api/client.ts";
import { login, setTempToken } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { Terminal, ArrowRight } from "lucide-react";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await post("/api/auth/login", { username, password });
      if (res.requires2FA) {
        setTempToken(res.tempToken, res.methods);
        window.location.hash = "#/2fa-verify";
      } else if (res.requires2FASetup) {
        setTempToken(res.tempToken);
        window.location.hash = "#/2fa-setup";
      } else {
        login(res.token, res.user);
        window.location.hash = "#/";
      }
    } catch (err: any) {
      showToast(err.message || "Login failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <Terminal size={24} className="text-fg" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">One-Click Deploy</h1>
        </div>
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
          <h2 className="font-mono text-sm font-bold text-fg uppercase mb-4">Sign In</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required autoFocus />
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
            >
              {loading ? <Spinner /> : <><span>Sign In</span><ArrowRight size={14} /></>}
            </button>
          </form>
          <div className="mt-4 flex items-center justify-between">
            <a
              href="#/password-reset"
              className="font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg"
            >
              Forgot password?
            </a>
            <a
              href="#/register"
              className="font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg"
            >
              Create account
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
