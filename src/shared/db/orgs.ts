import db from "./connection.ts";

// Types
export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type OrgMembershipRow = {
  id: number;
  org_id: string;
  user_id: string;
  role: string; // 'owner' | 'member'
  created_at: string;
};

export type OrgMemberWithUser = OrgMembershipRow & {
  username: string;
  is_admin: number;
};

export type OrgInvitationRow = {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string;
  created_by: string;
  created_at: string;
};

// Organization CRUD

export function insertOrg(id: string, name: string, slug: string): OrganizationRow {
  db.query("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
  return getOrg(id)!;
}

export function getOrg(id: string): OrganizationRow | null {
  return db.query("SELECT * FROM organizations WHERE id = ?").get(id) as OrganizationRow | null;
}

export function getOrgBySlug(slug: string): OrganizationRow | null {
  return db.query("SELECT * FROM organizations WHERE slug = ?").get(slug) as OrganizationRow | null;
}

export function getOrgs(): OrganizationRow[] {
  return db.query("SELECT * FROM organizations ORDER BY created_at").all() as OrganizationRow[];
}

export function updateOrg(id: string, name: string, slug: string): void {
  db.query("UPDATE organizations SET name = ?, slug = ? WHERE id = ?").run(name, slug, id);
}

export function deleteOrg(id: string): void {
  db.query("DELETE FROM organizations WHERE id = ?").run(id);
}

// Membership

export function getOrgsForUser(userId: string): Array<OrganizationRow & { role: string }> {
  return db
    .query(
      "SELECT o.*, m.role FROM organizations o JOIN org_memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at",
    )
    .all(userId) as Array<OrganizationRow & { role: string }>;
}

export function getOrgMembers(orgId: string): OrgMemberWithUser[] {
  return db
    .query(
      "SELECT m.*, u.username, u.is_admin FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at",
    )
    .all(orgId) as OrgMemberWithUser[];
}

export function insertOrgMember(orgId: string, userId: string, role: string): void {
  db.query("INSERT INTO org_memberships (org_id, user_id, role) VALUES (?, ?, ?)").run(orgId, userId, role);
}

export function updateOrgMemberRole(orgId: string, userId: string, role: string): void {
  db.query("UPDATE org_memberships SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
}

export function removeOrgMember(orgId: string, userId: string): void {
  db.query("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?").run(orgId, userId);
}

export function isOrgMember(orgId: string, userId: string): boolean {
  const row = db
    .query("SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?")
    .get(orgId, userId);
  return !!row;
}

export function getOrgRole(orgId: string, userId: string): string | null {
  const row = db
    .query("SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?")
    .get(orgId, userId) as { role: string } | null;
  return row?.role ?? null;
}

// Invitations

export function insertInvitation(
  id: string,
  orgId: string,
  email: string,
  role: string,
  token: string,
  expiresAt: string,
  createdBy: string,
): OrgInvitationRow {
  db.query(
    "INSERT INTO org_invitations (id, org_id, email, role, token, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, orgId, email, role, token, expiresAt, createdBy);
  return getInvitation(id)!;
}

export function getInvitation(id: string): OrgInvitationRow | null {
  return db.query("SELECT * FROM org_invitations WHERE id = ?").get(id) as OrgInvitationRow | null;
}

export function getInvitationByToken(token: string): OrgInvitationRow | null {
  return db.query("SELECT * FROM org_invitations WHERE token = ?").get(token) as OrgInvitationRow | null;
}

export function getOrgInvitations(orgId: string): OrgInvitationRow[] {
  return db
    .query("SELECT * FROM org_invitations WHERE org_id = ? ORDER BY created_at DESC")
    .all(orgId) as OrgInvitationRow[];
}

export function deleteInvitation(id: string): void {
  db.query("DELETE FROM org_invitations WHERE id = ?").run(id);
}

export function deleteExpiredInvitations(): void {
  db.query("DELETE FROM org_invitations WHERE expires_at < datetime('now')").run();
}

// Org Settings

export function getOrgSettings(orgId: string): Record<string, string> {
  const rows = db
    .query("SELECT key, value FROM org_settings WHERE org_id = ?")
    .all(orgId) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function getOrgSetting(orgId: string, key: string): string {
  const row = db
    .query("SELECT value FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, key) as { value: string } | null;
  return row?.value ?? "";
}

export function saveOrgSetting(orgId: string, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO org_settings (org_id, key, value) VALUES (?, ?, ?)").run(orgId, key, value);
}

// Org Permissions

export function getOrgPermissions(orgId: string, userId: string): string[] {
  const rows = db
    .query("SELECT permission FROM org_permissions WHERE org_id = ? AND user_id = ?")
    .all(orgId, userId) as Array<{ permission: string }>;
  return rows.map((r) => r.permission);
}

export function hasOrgPermission(orgId: string, userId: string, permission: string): boolean {
  const row = db
    .query("SELECT 1 FROM org_permissions WHERE org_id = ? AND user_id = ? AND permission = ?")
    .get(orgId, userId, permission);
  return !!row;
}

export function setOrgPermissions(orgId: string, userId: string, permissions: string[]): void {
  db.query("DELETE FROM org_permissions WHERE org_id = ? AND user_id = ?").run(orgId, userId);
  const stmt = db.prepare("INSERT INTO org_permissions (org_id, user_id, permission) VALUES (?, ?, ?)");
  for (const perm of permissions) {
    stmt.run(orgId, userId, perm);
  }
}

// Engine instances (for multi-engine support)

export type EngineInstanceRow = {
  id: string;
  heartbeat_at: string;
  started_at: string;
};

export function registerEngine(id: string): void {
  db.query(
    "INSERT OR REPLACE INTO engine_instances (id, heartbeat_at, started_at) VALUES (?, datetime('now'), datetime('now'))",
  ).run(id);
}

export function updateEngineHeartbeat(id: string): void {
  db.query("UPDATE engine_instances SET heartbeat_at = datetime('now') WHERE id = ?").run(id);
}

export function removeEngine(id: string): void {
  db.query("DELETE FROM engine_instances WHERE id = ?").run(id);
}

export function getLiveEngines(staleSeconds: number = 30): EngineInstanceRow[] {
  return db
    .query(
      "SELECT * FROM engine_instances WHERE heartbeat_at >= datetime('now', '-' || ? || ' seconds') ORDER BY id",
    )
    .all(staleSeconds) as EngineInstanceRow[];
}

export function removeStaleEngines(staleSeconds: number = 30): string[] {
  const stale = db
    .query(
      "SELECT id FROM engine_instances WHERE heartbeat_at < datetime('now', '-' || ? || ' seconds')",
    )
    .all(staleSeconds) as Array<{ id: string }>;
  db.query(
    "DELETE FROM engine_instances WHERE heartbeat_at < datetime('now', '-' || ? || ' seconds')",
  ).run(staleSeconds);
  return stale.map((r) => r.id);
}

export function isLeaderEngine(engineId: string, staleSeconds: number = 30): boolean {
  const engines = getLiveEngines(staleSeconds);
  return engines.length > 0 && engines[0].id === engineId;
}

// Resource locks (for multi-engine operation scheduling)

export function tryAcquireResourceLock(resourceKey: string, engineId: string, opId: number): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO resource_locks (resource_key, engine_id, op_id) VALUES (?, ?, ?)")
    .run(resourceKey, engineId, opId);
  return result.changes > 0;
}

export function releaseResourceLocks(opId: number): void {
  db.query("DELETE FROM resource_locks WHERE op_id = ?").run(opId);
}

export function releaseEngineResourceLocks(engineId: string): void {
  db.query("DELETE FROM resource_locks WHERE engine_id = ?").run(engineId);
}

export function getResourceLockHolder(resourceKey: string): { engine_id: string; op_id: number } | null {
  return db
    .query("SELECT engine_id, op_id FROM resource_locks WHERE resource_key = ?")
    .get(resourceKey) as { engine_id: string; op_id: number } | null;
}
