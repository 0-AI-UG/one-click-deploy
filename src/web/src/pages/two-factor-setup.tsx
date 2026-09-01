import { useState, useEffect } from "react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner, Card, Btn, AuthShell, InlineNotice } from "../components/ui.tsx";
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
    <AuthShell icon={<Shield size={32} />} title="Add a Passkey" description="Required to secure your account" width="md">
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
                {error && <InlineNotice tone="danger" className="mb-4">{error}</InlineNotice>}
                <Btn
                  onClick={register}
                  variant="primary"
                  size="md"
                  className="w-full justify-center"
                >
                  <Fingerprint size={14} /> {error ? "Try Again" : "Register Passkey"}
                </Btn>
              </>
            )}
          </Card>
        )}
    </AuthShell>
  );
}
