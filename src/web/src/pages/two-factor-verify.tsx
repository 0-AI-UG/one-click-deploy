import { useState, useEffect } from "react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner, Btn, Card, AuthShell, InlineNotice } from "../components/ui.tsx";
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
    <AuthShell icon={<Shield size={32} />} title="Verify with Passkey" description="Use Touch ID, Face ID, or a security key">
        {!supported ? (
          <PasskeyUnsupported onBack={() => { logout(); window.location.hash = "#/login"; }} />
        ) : (
          <Card className="p-6 text-center">
            <Fingerprint size={48} className="text-fg mx-auto mb-4" />
            {loading ? (
              <div className="flex justify-center py-2">
                <Spinner />
              </div>
            ) : (
              <>
                {error && <InlineNotice tone="danger" className="mb-4">{error}</InlineNotice>}
                <Btn
                  onClick={verify}
                  variant="primary"
                  size="md"
                  className="w-full justify-center"
                >
                  <Fingerprint size={14} /> {error ? "Try Again" : "Verify"}
                </Btn>
                <button
                  type="button"
                  onClick={() => { logout(); window.location.hash = "#/login"; }}
                  className="mt-3 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
                >
                  Cancel
                </button>
              </>
            )}
          </Card>
        )}
    </AuthShell>
  );
}
