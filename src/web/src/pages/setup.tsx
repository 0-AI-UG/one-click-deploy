import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { setTempToken } from "../stores/auth.ts";
import { showToast, Spinner, Card } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Terminal, ArrowRight, ArrowLeft, Key, Server } from "lucide-react";
import { type HetznerServerType, typeOptions, locationOptions } from "../hooks/use-server-types.ts";

export function SetupPage() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [serverTypes, setServerTypes] = useState<HetznerServerType[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  // When the panel was handed off from a bootstrap instance, the Hetzner
  // token is already present — skip the API-keys step and only ask for the
  // admin account.
  const [hasHetznerToken, setHasHetznerToken] = useState(false);

  useEffect(() => {
    get("/api/setup/status").then((res) => {
      setHasHetznerToken(!!res.hasHetznerToken);
    }).catch(() => {});
  }, []);
  const [form, setForm] = useState({
    email: "", password: "", confirmPassword: "",
    hetzner_api_token: "", github_pat: "",
    dns_zone_id: "", default_server_type: "", default_location: "",
  });

  // Debounced fetch of server types as the Hetzner token is typed.
  useEffect(() => {
    const token = form.hetzner_api_token.trim();
    if (!token) {
      setServerTypes([]);
      return;
    }
    setTypesLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await post("/api/setup/server-types", { hetzner_api_token: token });
        setServerTypes(res.server_types ?? []);
      } catch {
        setServerTypes([]);
      } finally {
        setTypesLoading(false);
      }
    }, 500);
    return () => { clearTimeout(handle); setTypesLoading(false); };
  }, [form.hetzner_api_token]);

  useEffect(() => {
    if (serverTypes.length > 0 && !form.default_server_type) {
      const first = serverTypes[0];
      setForm((f) => ({ ...f, default_server_type: first.name, default_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const validateStep1 = () => {
    if (!form.email || !form.password) { showToast("Email and password are required", "error"); return false; }
    if (form.password.length < 8) { showToast("Password must be at least 8 characters", "error"); return false; }
    if (form.password !== form.confirmPassword) { showToast("Passwords don't match", "error"); return false; }
    return true;
  };

  const nextStep = () => {
    if (step === 1 && !validateStep1()) return;
    setStep(step + 1);
  };

  const handleSubmit = async () => {
    if (!hasHetznerToken && !form.hetzner_api_token) return showToast("Hetzner API token is required", "error");
    setLoading(true);
    try {
      const res = await post("/api/setup/complete", form);
      setTempToken(res.tempToken);
      window.location.hash = "#/totp-setup";
    } catch (err: any) {
      showToast(err.message || "Setup failed", "error");
    } finally {
      setLoading(false);
    }
  };

  // In handoff mode, step 1 is the only step — finish setup right from there.
  const handleStep1Submit = async () => {
    if (!validateStep1()) return;
    if (hasHetznerToken) {
      await handleSubmit();
    } else {
      setStep(2);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg animate-slide-up">
        <div className="text-center mb-6">
          <Terminal size={32} className="text-fg mx-auto mb-3" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Initial Setup</h1>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Configure your deployment platform</p>
        </div>

        {/* Progress */}
        {!hasHetznerToken && (
          <div className="flex items-center gap-2 justify-center mb-6">
            {[1, 2].map((s) => (
              <div key={s} className="flex items-center gap-2">
                <div className={`w-7 h-7 flex items-center justify-center text-[10px] font-mono font-bold border-2 border-fg ${
                  step >= s ? "bg-accent text-fg" : "bg-alt text-muted"
                }`}>{s}</div>
                {s < 2 && <div className={`w-12 h-0.5 ${step > s ? "bg-fg" : "bg-alt"}`} />}
              </div>
            ))}
          </div>
        )}

        <Card className="p-6">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Key size={16} className="text-fg" />
                <h3 className="font-mono font-bold text-sm text-fg uppercase">Admin Account</h3>
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Email</label>
                <input type="email" value={form.email} onChange={set("email")} placeholder="admin@example.com" autoFocus />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Password</label>
                <input type="password" value={form.password} onChange={set("password")} placeholder="Min 8 characters" />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Confirm Password</label>
                <input type="password" value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="Confirm password" />
              </div>
              <button onClick={handleStep1Submit} disabled={loading} className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35">
                {loading ? <Spinner /> : (
                  hasHetznerToken
                    ? <><span>Complete Setup</span><ArrowRight size={14} /></>
                    : <><span>Next</span><ArrowRight size={14} /></>
                )}
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Server size={16} className="text-fg" />
                <h3 className="font-mono font-bold text-sm text-fg uppercase">API Keys & Defaults</h3>
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner API Token *</label>
                <input type="password" value={form.hetzner_api_token} onChange={set("hetzner_api_token")} placeholder="Required" />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">GitHub PAT</label>
                <input type="password" value={form.github_pat} onChange={set("github_pat")} placeholder="Optional — needed for webhooks" />
              </div>
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID</label>
                <input type="text" value={form.dns_zone_id} onChange={set("dns_zone_id")} placeholder="Optional" />
              </div>
              <div className="text-[9px] font-mono uppercase tracking-wider text-muted -mt-1">
                {typesLoading ? "Loading server types…" : serverTypes.length === 0 ? "Enter a valid Hetzner token to load server types" : `${serverTypes.length} server types available`}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
                  <NeoSelect
                    value={form.default_server_type}
                    onChange={(v) => {
                      setForm((f) => {
                        const locs = locationOptions(serverTypes, v);
                        const locValid = locs.some((l) => l.value === f.default_location);
                        return { ...f, default_server_type: v, ...(!locValid && locs.length ? { default_location: locs[0].value } : {}) };
                      });
                    }}
                    options={typeOptions(serverTypes)}
                  />
                </div>
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Location</label>
                  <NeoSelect
                    value={form.default_location}
                    onChange={(v) => setForm((f) => ({ ...f, default_location: v }))}
                    options={locationOptions(serverTypes, form.default_server_type)}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setStep(1)} className="flex-1 flex items-center justify-center gap-2 bg-bg-raised text-fg-dim border-2 border-fg shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all">
                  <ArrowLeft size={14} /><span>Back</span>
                </button>
                <button onClick={handleSubmit} disabled={loading} className="flex-1 flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35">
                  {loading ? <Spinner /> : <><span>Complete Setup</span><ArrowRight size={14} /></>}
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
