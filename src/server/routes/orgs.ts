import { authenticateRequest } from "../lib/auth.ts";
import { requireOrgContext, requireOrgOwner } from "../lib/org-context.ts";
import * as db from "../../shared/db.ts";
import { secretStore, maskToken } from "../../shared/secret-store.ts";
import { syncSubscriptionSeats } from "./billing.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";

// GET /api/orgs — list user's orgs
export async function handleListOrgs(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request);
  const orgs = db.getOrgsForUser(auth.userId);
  return Response.json(orgs);
}

// POST /api/orgs — create org
export async function handleCreateOrg(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request);
  const { name, slug } = await request.json();
  if (!name || !slug) return Response.json({ error: "Name and slug required" }, { status: 400 });
  // Validate slug format (lowercase, alphanumeric, hyphens)
  if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "Slug must be lowercase alphanumeric with hyphens" }, { status: 400 });
  if (db.getOrgBySlug(slug)) return Response.json({ error: "Slug already taken" }, { status: 409 });
  const id = crypto.randomUUID();
  const org = db.insertOrg(id, name, slug);
  db.insertOrgMember(id, auth.userId, "owner");
  return Response.json(org, { status: 201 });
}

// GET /api/orgs/:orgId — get org details
export async function handleGetOrg(request: Request): Promise<Response> {
  const ctx = await requireOrgContext(request);
  const org = db.getOrg(ctx.orgId);
  if (!org) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(org);
}

// PUT /api/orgs/:orgId — update org
export async function handleUpdateOrg(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const { name, slug } = await request.json();
  if (!name || !slug) return Response.json({ error: "Name and slug required" }, { status: 400 });
  if (!/^[a-z0-9-]+$/.test(slug)) return Response.json({ error: "Invalid slug format" }, { status: 400 });
  const existing = db.getOrgBySlug(slug);
  if (existing && existing.id !== ctx.orgId) return Response.json({ error: "Slug already taken" }, { status: 409 });
  db.updateOrg(ctx.orgId, name, slug);
  return Response.json(db.getOrg(ctx.orgId));
}

// DELETE /api/orgs/:orgId — delete org (owner only)
export async function handleDeleteOrg(request: Request): Promise<Response> {
  const ctx = await requireOrgContext(request);
  if (ctx.orgRole !== "owner") return Response.json({ error: "Only the owner can delete an org" }, { status: 403 });
  db.deleteOrg(ctx.orgId);
  return Response.json({ ok: true });
}

// GET /api/orgs/:orgId/members
export async function handleGetOrgMembers(request: Request): Promise<Response> {
  const ctx = await requireOrgContext(request);
  const members = db.getOrgMembers(ctx.orgId);
  return Response.json(members);
}

// POST /api/orgs/:orgId/invitations — send invite
export async function handleCreateInvitation(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const { email } = await request.json();
  if (!email) return Response.json({ error: "Email required" }, { status: 400 });
  const inviteRole = "member";
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  db.deleteExpiredInvitations();
  const invitation = db.insertInvitation(id, ctx.orgId, email, inviteRole, token, expiresAt, ctx.userId);
  return Response.json(invitation, { status: 201 });
}

// GET /api/orgs/:orgId/invitations — list invitations
export async function handleGetOrgInvitations(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const invitations = db.getOrgInvitations(ctx.orgId);
  return Response.json(invitations);
}

// DELETE /api/orgs/:orgId/members/:userId — remove member
export async function handleRemoveOrgMember(request: Request, userId: string): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  if (userId === ctx.userId) return Response.json({ error: "Cannot remove yourself" }, { status: 400 });
  const targetRole = db.getOrgRole(ctx.orgId, userId);
  if (!targetRole) return Response.json({ error: "User is not a member" }, { status: 404 });
  if (targetRole === "owner") return Response.json({ error: "Cannot remove the owner" }, { status: 403 });
  db.removeOrgMember(ctx.orgId, userId);
  syncSubscriptionSeats(ctx.orgId).catch((err) => {
    console.error(`[billing] seat sync failed after removing member from org ${ctx.orgId}:`, err);
  });
  return Response.json({ ok: true });
}

// GET /api/orgs/:orgId/settings
export async function handleGetOrgSettings(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const settings = db.getOrgSettings(ctx.orgId);
  // Also include masked provider token
  const provider = await secretStore.getProviderToken(ctx.orgId);
  return Response.json({ ...settings, provider_token_masked: maskToken(provider) });
}

// PUT /api/orgs/:orgId/settings — update org settings (credentials + defaults)
export async function handleUpdateOrgSettings(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const body = await request.json();
  const settingKeys = ["dns_zone_id", "default_server_type", "default_location", "ssh_public_key", "network_id"];
  for (const key of settingKeys) {
    if (body[key] !== undefined) {
      db.saveOrgSetting(ctx.orgId, key, body[key]);
    }
  }
  if (body.provider_token) {
    await secretStore.set("hetzner_api_token", body.provider_token, ctx.orgId);
  }
  return Response.json({ ok: true });
}

// POST /api/orgs/:orgId/server-types — fetch server types using a provider token
// If no token in body, uses the org's stored token.
export async function handleOrgServerTypes(request: Request): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const body = await request.json() as { provider_token?: string };
  let token = body.provider_token?.trim() || "";

  // Fall back to the org's stored token
  if (!token) {
    token = await secretStore.getProviderToken(ctx.orgId);
  }
  if (!token) return Response.json({ server_types: [], locations: [] });

  const provider = getComputeProvider();
  const validation = provider.validateToken(token);
  if (!validation.valid) {
    return Response.json({ error: `Invalid token: ${validation.error}` }, { status: 400 });
  }
  try {
    await provider.verifyToken(token);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
  // Fetch server types directly with the in-hand token — avoids writing to
  // secretStore at all (global or org-scoped) for this one-off preview request.
  // provider.listServerTypes() sources its token via secretStore.get without
  // an orgId, which would create a cross-tenant race if we wrote here first.
  const res = await fetch("https://api.hetzner.cloud/v1/server_types?per_page=50", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    return Response.json({ error: "Failed to fetch server types from provider" }, { status: 502 });
  }
  const data = await res.json() as { server_types?: Array<{ name: string; description: string; cores: number; memory: number; disk: number; deprecation?: { announced?: string } | null; prices?: Array<{ location: string }> }> };
  const rawTypes = data.server_types ?? [];
  const types = rawTypes
    .filter((t) => !t.deprecation?.announced)
    .map((t) => ({
      name: t.name,
      description: t.description,
      cores: t.cores,
      memory: t.memory,
      disk: t.disk,
      locations: (t.prices ?? []).map((p) => p.location),
    }))
    .sort((a, b) => a.memory - b.memory || a.cores - b.cores);
  const allLocations = [...new Set(types.flatMap((t) => t.locations))].sort();
  return Response.json({ server_types: types, locations: allLocations });
}

// GET /api/orgs/:orgId/members/:userId/permissions
export async function handleGetMemberPermissions(request: Request, userId: string): Promise<Response> {
  await requireOrgOwner(request);
  const ctx = await requireOrgContext(request);
  const permissions = db.getOrgPermissions(ctx.orgId, userId);
  return Response.json(permissions);
}

// PUT /api/orgs/:orgId/members/:userId/permissions
export async function handleUpdateMemberPermissions(request: Request, userId: string): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const { permissions } = await request.json();
  if (!Array.isArray(permissions)) return Response.json({ error: "permissions must be an array" }, { status: 400 });
  if (!db.isOrgMember(ctx.orgId, userId)) return Response.json({ error: "User is not a member" }, { status: 404 });
  const targetRole = db.getOrgRole(ctx.orgId, userId);
  if (targetRole === "owner") {
    return Response.json({ error: "Owners bypass permissions" }, { status: 400 });
  }
  db.setOrgPermissions(ctx.orgId, userId, permissions);
  return Response.json({ ok: true });
}

// DELETE /api/orgs/:orgId/invitations/:invitationId — revoke invitation
export async function handleRevokeInvitation(request: Request, invitationId: string): Promise<Response> {
  const ctx = await requireOrgOwner(request);
  const invitation = db.getInvitation(invitationId);
  if (!invitation || invitation.org_id !== ctx.orgId) {
    return Response.json({ error: "Invitation not found" }, { status: 404 });
  }
  db.deleteInvitation(invitationId);
  return Response.json({ ok: true });
}
