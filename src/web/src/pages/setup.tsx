import { useState } from "react";
import { post } from "../api/client.ts";
import { setTempToken } from "../stores/auth.ts";
import { showToast, Spinner, Card, Field } from "../components/ui.tsx";
import { Terminal, ArrowRight, Key } from "lucide-react";

export function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    confirmPassword: "",
    default_domain_suffix: "",
  });

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async () => {
    if (!form.username || !form.password) return showToast("Username and password are required", "error");
    if (form.password.length < 8) return showToast("Password must be at least 8 characters", "error");
    if (form.password !== form.confirmPassword) return showToast("Passwords don't match", "error");
    setLoading(true);
    try {
      const result = await post("/api/setup/complete", form);
      setTempToken(result.tempToken);
      window.location.hash = "#/2fa-setup";
    } catch (error: any) {
      showToast(error.message || "Setup failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg animate-slide-up">
        <div className="text-center mb-6">
          <Terminal size={32} className="text-fg mx-auto mb-3" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Initial Setup</h1>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Create the administrator account</p>
        </div>
        <Card className="p-6">
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Key size={16} className="text-fg" />
              <h3 className="font-mono font-bold text-sm text-fg uppercase">Admin Account</h3>
            </div>
            <Field label="Username"><input type="text" value={form.username} onChange={set("username")} placeholder="admin" autoFocus /></Field>
            <Field label="Password"><input type="password" value={form.password} onChange={set("password")} placeholder="Min 8 characters" /></Field>
            <Field label="Confirm Password"><input type="password" value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="Confirm password" /></Field>
            <Field
              label="Default Domain Suffix"
              align="start"
              hint="Optional. OCD only shows the DNS records you should create; it never changes DNS."
            >
              <input type="text" value={form.default_domain_suffix} onChange={set("default_domain_suffix")} placeholder="apps.example.com" />
            </Field>
            <p className="text-[9px] font-mono text-muted uppercase tracking-wider">
              Cloud credentials are optional and can be configured later. You can also connect an existing server.
            </p>
            <button onClick={handleSubmit} disabled={loading} className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35">
              {loading ? <Spinner /> : <><span>Complete Setup</span><ArrowRight size={14} /></>}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
