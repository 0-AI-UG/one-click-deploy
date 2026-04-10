import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../components/ui.tsx";
import { User, Shield, Fingerprint, KeyRound, Trash2, LogOut, GitBranch, LinkIcon, Unlink } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { logout, useAuth, updateUser } from "../stores/auth.ts";

type PasskeyInfo = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string };

function SecuritySection() {
  const [status, setStatus] = useState<any>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const refresh = () => {
    Promise.all([
      get("/api/auth/totp/status"),
      get("/api/auth/webauthn/credentials"),
    ]).then(([s, p]) => {
      setStatus(s);
      setPasskeys(p);
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const addPasskey = async () => {
    setBusy(true);
    try {
      const options = await post("/api/auth/webauthn/register-options");
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify", { credential });
      if (res.backupCodes) {
        showToast(`Passkey added. Save your backup codes: ${res.backupCodes.join(", ")}`, "success");
      } else {
        showToast("Passkey added", "success");
      }
      refresh();
    } catch (err: any) {
      if (err.name !== "NotAllowedError") {
        showToast(err.message || "Failed to add passkey", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const deletePasskey = async (id: string, name: string) => {
    if (!confirm(`Remove passkey "${name}"?`)) return;
    setBusy(true);
    try {
      await post("/api/auth/webauthn/delete", { credentialId: id });
      showToast("Passkey removed", "success");
      refresh();
    } catch (err: any) {
      showToast(err.message || "Failed to remove passkey", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="p-5 mt-6"><div className="flex justify-center"><Spinner /></div></Card>;
  if (!status) return null;

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Security</h3>
      </div>

      {/* TOTP Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-muted" />
          <span className="font-mono text-[11px] text-fg font-bold">Authenticator App</span>
        </div>
        <span className={`font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg ${status.enabled ? "bg-green-200" : "bg-alt"}`}>
          {status.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {/* Passkeys */}
      <div className="border-t-2 border-fg pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Fingerprint size={14} className="text-muted" />
            <span className="font-mono text-[11px] text-fg font-bold">Passkeys</span>
          </div>
          {supportsWebAuthn && (
            <Btn size="xs" loading={busy} onClick={addPasskey}>
              + Add Passkey
            </Btn>
          )}
        </div>
        {passkeys.length === 0 ? (
          <p className="font-mono text-[10px] text-muted">No passkeys registered.</p>
        ) : (
          <div className="space-y-1">
            {passkeys.map((pk) => (
              <div key={pk.id} className="flex items-center justify-between bg-alt border-2 border-fg px-3 py-2">
                <div>
                  <span className="font-mono text-[10px] text-fg font-bold">{pk.name}</span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {pk.backedUp ? "Synced" : pk.deviceType === "singleDevice" ? "Device-bound" : ""}
                  </span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    {new Date(pk.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  onClick={() => deletePasskey(pk.id, pk.name)}
                  disabled={busy}
                  className="text-muted hover:text-red-500 transition-colors disabled:opacity-35"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!supportsWebAuthn && (
          <p className="font-mono text-[9px] text-muted mt-1">Your browser does not support passkeys.</p>
        )}
      </div>

      {/* Backup codes */}
      {(status.enabled || status.webauthnEnabled) && (
        <div className="border-t-2 border-fg pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-fg font-bold">Backup Codes</span>
            <span className="font-mono text-[10px] text-muted">{status.backupCodesRemaining} remaining</span>
          </div>
        </div>
      )}

      {/* Change password */}
      <div className="border-t-2 border-fg pt-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-fg font-bold">Password</span>
            <p className="font-mono text-[9px] text-muted mt-0.5">You will be signed out and redirected to the password reset page.</p>
          </div>
          <Btn size="xs" onClick={() => { logout(); window.location.hash = "#/password-reset"; }}>
            <LogOut size={11} /> Change Password
          </Btn>
        </div>
      </div>
    </Card>
  );
}

function GitHubSection() {
  const { user } = useAuth();
  const [status, setStatus] = useState<{ linked: boolean; githubUsername: string; avatarUrl: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    get("/api/auth/github/status")
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // Check for OAuth callback result in URL
    const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
    if (params.get("github") === "linked") {
      showToast("GitHub account linked", "success");
      // Refresh user data so the auth store is up to date
      get("/api/me").then((data: any) => { if (data.user) updateUser(data.user); }).catch(() => {});
      // Clean URL
      window.location.hash = "#/account";
    } else if (params.get("github") === "error") {
      const reason = params.get("reason") || "unknown";
      const messages: Record<string, string> = {
        missing_params: "GitHub did not return the expected parameters",
        invalid_state: "Session expired. Please try again.",
        not_configured: "GitHub OAuth is not configured by the admin",
        token_exchange: "Failed to exchange code with GitHub",
        user_fetch: "Failed to fetch your GitHub profile",
        internal: "An internal error occurred",
      };
      showToast(messages[reason] || "Failed to link GitHub", "error");
      window.location.hash = "#/account";
    }
  }, []);

  const linkGitHub = async () => {
    setBusy(true);
    try {
      const { url } = await get("/api/auth/github/authorize");
      window.location.href = url;
    } catch (err: any) {
      showToast(err.message || "Failed to start GitHub OAuth", "error");
      setBusy(false);
    }
  };

  const unlinkGitHub = async () => {
    setBusy(true);
    try {
      await post("/api/auth/github/unlink");
      showToast("GitHub account unlinked", "success");
      setStatus({ linked: false, githubUsername: "", avatarUrl: "" });
      // Refresh user data
      get("/api/me").then((data: any) => { if (data.user) updateUser(data.user); }).catch(() => {});
    } catch (err: any) {
      showToast(err.message || "Failed to unlink", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="p-5 mt-6"><div className="flex justify-center"><Spinner /></div></Card>;

  const linked = status?.linked || user?.githubLinked;
  const username = status?.githubUsername || user?.githubUsername || "";
  const avatar = status?.avatarUrl || user?.githubAvatarUrl || "";

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">GitHub</h3>
      </div>

      {linked ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {avatar && (
              <img src={avatar} alt={username} className="w-8 h-8 border-2 border-fg" />
            )}
            <div>
              <span className="font-mono text-[11px] text-fg font-bold">@{username}</span>
              <span className="font-mono text-[9px] font-bold uppercase px-2 py-0.5 border-2 border-fg bg-green-200 ml-2">Linked</span>
            </div>
          </div>
          <Btn size="xs" loading={busy} onClick={unlinkGitHub}>
            <Unlink size={11} /> Unlink
          </Btn>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-fg font-bold">Not linked</span>
            <p className="font-mono text-[9px] text-muted mt-0.5">Link your GitHub to deploy private repos and pull private ghcr.io images.</p>
          </div>
          <Btn size="xs" loading={busy} onClick={linkGitHub}>
            <LinkIcon size={11} /> Link GitHub
          </Btn>
        </div>
      )}
    </Card>
  );
}

export function AccountPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-6">
        <User size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Account</h1>
      </div>

      <GitHubSection />
      <SecuritySection />
    </div>
  );
}
