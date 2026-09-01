import { useState } from "react";
import { post } from "../api/client.ts";
import { showToast, Btn, Field, Card, AuthShell } from "../components/ui.tsx";
import { KeyRound, Fingerprint, ArrowLeft } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";

export function PasswordResetPage() {
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const supported = browserSupportsWebAuthn();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) return showToast("Enter your username first", "error");
    if (newPassword !== confirm) return showToast("Passwords do not match", "error");
    if (newPassword.length < 8) return showToast("Password must be at least 8 characters", "error");
    setLoading(true);
    try {
      const options = await post("/api/auth/password-reset/webauthn-options", { username });
      const credential = await startAuthentication({ optionsJSON: options });
      await post("/api/auth/password-reset/webauthn-verify", { username, credential, newPassword });
      showToast("Password reset. You can now sign in.", "success");
      window.location.hash = "#/login";
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        showToast("Passkey verification was cancelled.", "error");
      } else {
        showToast(err.message || "Password reset failed", "error");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell icon={<KeyRound size={24} />} title="Reset Password">

        {!supported ? (
          <PasskeyUnsupported onBack={() => { window.location.hash = "#/login"; }} />
        ) : (
          <Card className="p-6">
            <p className="text-[10px] text-muted font-mono mb-4 uppercase tracking-wider">
              Enter your username and new password, then verify with your passkey.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="Username">
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" required autoFocus />
              </Field>
              <Field label="New password">
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
              </Field>
              <Field label="Confirm new password">
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required minLength={8} />
              </Field>
              <Btn
                type="submit"
                variant="primary"
                size="md"
                loading={loading}
                className="w-full justify-center"
              >
                <Fingerprint size={14} /><span>Verify & Reset</span>
              </Btn>
            </form>
            <div className="mt-4 text-center">
              <Btn variant="ghost" onClick={() => { window.location.hash = "#/login"; }}><ArrowLeft size={14} /></Btn>
            </div>
          </Card>
        )}
    </AuthShell>
  );
}
