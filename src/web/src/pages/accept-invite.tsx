import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { useAuth, setOrgs, setCurrentOrg } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";

export function AcceptInvitePage({ token }: { token: string }) {
  const { token: authToken } = useAuth();
  const [invitation, setInvitation] = useState<{ org_name: string; invitation: { role: string } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get(`/api/invitations/${token}`).then(setInvitation).catch((err) => {
      setError(err.message);
    }).finally(() => setLoading(false));
  }, [token]);

  const handleAccept = async () => {
    if (!authToken) {
      window.location.hash = `#/login`;
      return;
    }
    setAccepting(true);
    try {
      const res = await post(`/api/invitations/${token}/accept`);
      // Refresh orgs list
      const orgs = await get("/api/orgs");
      setOrgs(orgs);
      setCurrentOrg(res.org_id);
      showToast("Joined organization!");
      window.location.hash = "#/";
    } catch (err: any) {
      showToast(err.message, "error");
    } finally { setAccepting(false); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  if (error) return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="bg-white border-2 border-fg shadow-neo p-8 max-w-sm text-center">
        <p className="font-mono text-sm text-fg mb-4">{error}</p>
        <a href="#/" className="font-mono text-xs text-fg underline">Go to Dashboard</a>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm bg-white border-2 border-fg shadow-neo p-8 text-center">
        <h1 className="font-mono font-bold text-xl mb-2 text-fg">Join Organization</h1>
        <p className="font-mono text-sm text-fg/60 mb-6">
          You've been invited to join <strong>{invitation?.org_name}</strong> as a {invitation?.invitation.role}.
        </p>
        {!authToken ? (
          <div>
            <p className="font-mono text-xs text-fg/60 mb-4">Please log in or register to accept this invitation.</p>
            <a href="#/login" className="inline-block bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo">Log In</a>
          </div>
        ) : (
          <button onClick={handleAccept} disabled={accepting} className="w-full bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo hover:-translate-y-0.5 hover:shadow-neo-lg transition-all disabled:opacity-50">
            {accepting ? <Spinner /> : "Accept Invitation"}
          </button>
        )}
      </div>
    </div>
  );
}
