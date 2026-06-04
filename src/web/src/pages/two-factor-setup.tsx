import { useState, useEffect } from "react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner, Card } from "../components/ui.tsx";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";
import { Fingerprint, Shield } from "lucide-react";

export function TwoFactorSetupPage() {
  const { tempToken, token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supported = browserSupportsWebAuthn();

  const register = async () => {
    if (!tempToken) return;
    setError("");
    setLoading(true);
    try {
      const options = await post("/api/auth/webauthn/register-options-from-login", { tempToken });
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify-from-login", { tempToken, credential });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      setError(err.name === "NotAllowedError" ? "Passkey registration was cancelled." : err.message || "Passkey registration failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supported && tempToken) register();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md animate-slide-up">
        <div className="text-center mb-6">
          <Shield size={32} className="text-fg mx-auto mb-3" />
          <h2 className="font-mono font-bold text-sm text-fg uppercase">Add a Passkey</h2>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">
            Required to secure your account
          </p>
        </div>

        {!supported ? (
          <PasskeyUnsupported onBack={() => { logout(); window.location.hash = "#/login"; }} />
        ) : (
          <Card className="p-6 text-center">
            <Fingerprint size={48} className="text-fg mx-auto mb-4" />
            {loading ? (
              <>
                <p className="text-[10px] text-muted font-mono uppercase tracking-wider mb-4">
                  Follow your browser's prompt to register a passkey
                </p>
                <Spinner />
              </>
            ) : (
              <>
                {error && <p className="text-[10px] text-red-500 font-mono mb-4">{error}</p>}
                <button
                  onClick={register}
                  className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all"
                >
                  <Fingerprint size={14} /> {error ? "Try Again" : "Register Passkey"}
                </button>
              </>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
