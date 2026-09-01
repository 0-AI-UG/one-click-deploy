import { useState } from "react";
import { post } from "../api/client.ts";
import { login, setTempToken } from "../stores/auth.ts";
import { showToast, Field, Card, Btn, AuthShell } from "../components/ui.tsx";
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
        setTempToken(res.tempToken);
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
    <AuthShell icon={<Terminal size={24} />} title="One-Click Deploy">
        <Card className="p-6">
          <h2 className="font-mono text-sm font-bold text-fg uppercase mb-4">Sign In</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Username">
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required autoFocus />
            </Field>
            <Field label="Password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </Field>
            <Btn
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              className="w-full justify-center"
            >
              <span>Sign In</span><ArrowRight size={14} />
            </Btn>
          </form>
          <div className="mt-4 text-center">
            <a
              href="#/password-reset"
              className="font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg"
            >
              Forgot password?
            </a>
          </div>
        </Card>
    </AuthShell>
  );
}
