import { useState, useEffect } from "react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner } from "../components/ui.tsx";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";
import { Shield, Fingerprint } from "lucide-react";

export function TwoFactorVerifyPage() {
  const { tempToken, token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supported = browserSupportsWebAuthn();

  const verify = async () => {
    if (!tempToken) return;
    setError("");
    setLoading(true);
    try {
      const options = await post("/api/auth/webauthn/login-options", { tempToken });
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/login-verify", { tempToken, credential });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      setError(err.name === "NotAllowedError" ? "Passkey verification was cancelled." : err.message || "Passkey verification failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supported && tempToken) verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up text-center">
        <Shield size={32} className="text-fg mx-auto mb-4" />
        <h2 className="font-mono font-bold text-sm text-fg uppercase mb-1">Verify with Passkey</h2>
        <p className="text-[10px] text-muted mb-6 font-mono uppercase tracking-wider">
          Use Touch ID, Face ID, or a security key
        </p>

        {!supported ? (
          <PasskeyUnsupported onBack={() => { logout(); window.location.hash = "#/login"; }} />
        ) : (
          <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
            <Fingerprint size={48} className="text-fg mx-auto mb-4" />
            {loading ? (
              <Spinner />
            ) : (
              <>
                {error && <p className="text-[10px] text-red-500 font-mono mb-4">{error}</p>}
                <button
                  onClick={verify}
                  className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all"
                >
                  <Fingerprint size={14} /> {error ? "Try Again" : "Verify"}
                </button>
                <button
                  type="button"
                  onClick={() => { logout(); window.location.hash = "#/login"; }}
                  className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
