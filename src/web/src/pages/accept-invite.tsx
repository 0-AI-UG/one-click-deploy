import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { useAuth, setOrgs, setCurrentOrg, orgPath } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { errMsg } from "../lib/errors.ts";

type InvitationDetails = {
  org_name: string;
  invitee_username: string | null;
  invitation: { role: string };
};

export function AcceptInvitePage({ token }: { token: string }) {
  const { token: authToken, user } = useAuth();
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get(`/api/invitations/${token}`).then(setInvitation).catch((err) => {
      setError(errMsg(err));
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
      const orgs = await get("/api/orgs");
      setOrgs(orgs);
      setCurrentOrg(res.org_id);
      showToast("Joined organization!");
      window.location.hash = orgPath("/");
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally { setAccepting(false); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  if (error) return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="bg-white border-2 border-fg shadow-neo p-8 max-w-sm text-center">
        <p className="font-mono text-sm text-fg mb-4">{error}</p>
        <a href={orgPath("/")} className="font-mono text-xs text-fg underline">Go to Dashboard</a>
      </div>
    </div>
  );

  const inviteeUsername = invitation?.invitee_username ?? "";
  const wrongAccount = !!authToken && !!user && !!inviteeUsername && user.username !== inviteeUsername;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm bg-white border-2 border-fg shadow-neo p-8 text-center">
        <h1 className="font-mono font-bold text-xl mb-2 text-fg">Join Organization</h1>
        <p className="font-mono text-sm text-fg/60 mb-6">
          <strong>{inviteeUsername || "You"}</strong> has been invited to join{" "}
          <strong>{invitation?.org_name}</strong> as a {invitation?.invitation.role}.
        </p>
        {!authToken ? (
          <div>
            <p className="font-mono text-xs text-fg/60 mb-4">
              Please log in {inviteeUsername ? <>as <strong>{inviteeUsername}</strong></> : null} to accept this invitation.
            </p>
            <a href="#/login" className="inline-block bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo">Log In</a>
          </div>
        ) : wrongAccount ? (
          <p className="font-mono text-xs text-accent-red">
            You're signed in as <strong>{user?.username}</strong>, but this invite is for{" "}
            <strong>{inviteeUsername}</strong>. Log out and back in as that user to accept.
          </p>
        ) : (
          <button onClick={handleAccept} disabled={accepting} className="w-full bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo hover:-translate-y-0.5 hover:shadow-neo-lg transition-all disabled:opacity-50">
            {accepting ? <Spinner /> : "Accept Invitation"}
          </button>
        )}
      </div>
    </div>
  );
}
