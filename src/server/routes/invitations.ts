import { authenticateRequest } from "../lib/auth.ts";
import * as db from "../../shared/db.ts";
import { syncSubscriptionSeats } from "./billing.ts";

// GET /api/invitations/:token — get invitation details (public)
export async function handleGetInvitation(request: Request, token: string): Promise<Response> {
  const invitation = db.getInvitationByToken(token);
  if (!invitation) return Response.json({ error: "Invitation not found or expired" }, { status: 404 });
  if (new Date(invitation.expires_at) < new Date()) {
    db.deleteInvitation(invitation.id);
    return Response.json({ error: "Invitation expired" }, { status: 410 });
  }
  const org = db.getOrg(invitation.org_id);
  const invitee = db.getUserById(invitation.invitee_user_id);
  return Response.json({
    invitation,
    org_name: org?.name,
    invitee_username: invitee?.username ?? null,
  });
}

// POST /api/invitations/:token/accept
export async function handleAcceptInvitation(request: Request, token: string): Promise<Response> {
  const auth = await authenticateRequest(request);
  const invitation = db.getInvitationByToken(token);
  if (!invitation) return Response.json({ error: "Invitation not found" }, { status: 404 });
  if (new Date(invitation.expires_at) < new Date()) {
    db.deleteInvitation(invitation.id);
    return Response.json({ error: "Invitation expired" }, { status: 410 });
  }
  // The token is the only credential, so the authenticated identity must
  // match the user the invite was issued to — otherwise anyone with the
  // link could claim the seat.
  if (invitation.invitee_user_id !== auth.userId) {
    const invitee = db.getUserById(invitation.invitee_user_id);
    return Response.json(
      { error: `This invitation is for ${invitee?.username ?? "another user"}` },
      { status: 403 },
    );
  }
  if (db.isOrgMember(invitation.org_id, auth.userId)) {
    db.deleteInvitation(invitation.id);
    return Response.json({ error: "Already a member" }, { status: 409 });
  }
  db.insertOrgMember(invitation.org_id, auth.userId, invitation.role);
  db.deleteInvitation(invitation.id);
  syncSubscriptionSeats(invitation.org_id).catch((err) => {
    console.error(`[billing] seat sync failed after invitation accept for org ${invitation.org_id}:`, err);
  });
  return Response.json({ ok: true, org_id: invitation.org_id });
}
