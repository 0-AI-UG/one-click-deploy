import { useState } from "react";
import { post } from "../api/client.ts";
import { setTempToken } from "../stores/auth.ts";
import { showToast, Spinner, Card } from "../components/ui.tsx";
import { Terminal, ArrowRight } from "lucide-react";
import { errMsg } from "../lib/errors.ts";

export function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", confirmPassword: "" });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) { showToast("Username and password are required", "error"); return; }
    if (form.password.length < 8) { showToast("Password must be at least 8 characters", "error"); return; }
    if (form.password !== form.confirmPassword) { showToast("Passwords don't match", "error"); return; }

    setLoading(true);
    try {
      const res = await post("/api/setup/complete", { username: form.username, password: form.password });
      setTempToken(res.tempToken);
      window.location.hash = "#/2fa-setup";
    } catch (err) {
      showToast(errMsg(err) || "Setup failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg animate-slide-up">
        <div className="text-center mb-6">
          <Terminal size={32} className="text-fg mx-auto mb-3" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Create Account</h1>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Set up your account to get started</p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
              <input type="text" value={form.username} onChange={set("username")} placeholder="Choose a username" autoFocus />
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Password</label>
              <input type="password" value={form.password} onChange={set("password")} placeholder="Min 8 characters" />
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Confirm Password</label>
              <input type="password" value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="Confirm password" />
            </div>

            <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35">
              {loading ? <Spinner /> : <><span>Continue</span><ArrowRight size={14} /></>}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
