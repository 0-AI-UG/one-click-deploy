import { useState } from "react";
import { post } from "../api/client.ts";
import { login } from "../stores/auth.ts";
import { showToast } from "../components/ui.tsx";
import { Spinner } from "../components/ui.tsx";
import { errMsg } from "../lib/errors.ts";

export function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      showToast("Passwords do not match", "error");
      return;
    }
    if (password.length < 8) {
      showToast("Password must be at least 8 characters", "error");
      return;
    }
    setLoading(true);
    try {
      const res = await post("/api/auth/register", { username, password });
      login(res.token, res.user);
      window.location.hash = "#/create-org";
    } catch (err) {
      showToast(errMsg(err) || "Registration failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm bg-white border-2 border-fg shadow-neo p-8">
        <h1 className="font-mono font-bold text-xl mb-6 text-fg">Create Account</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Confirm Password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
          </div>
          <button type="submit" disabled={loading} className="w-full bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo hover:-translate-y-0.5 hover:shadow-neo-lg transition-all disabled:opacity-50">
            {loading ? <Spinner /> : "Sign Up"}
          </button>
        </form>
        <p className="mt-4 text-center font-mono text-xs text-fg/60">
          Already have an account? <a href="#/login" className="text-fg underline">Log in</a>
        </p>
      </div>
    </div>
  );
}
