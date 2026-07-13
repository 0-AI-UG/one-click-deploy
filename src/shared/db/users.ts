import db from "./connection.ts";

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  webauthn_enabled: number;
  github_id: number | null;
  github_username: string;
  github_avatar_url: string;
  github_linked_at: string | null;
  created_at: string;
  token_version: number;
};

export type WebAuthnCredential = {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  device_type: string;
  backed_up: number;
  transports: string;
  name: string;
  created_at: string;
};

export const ALL_PERMISSIONS = [
  "apps.deploy",
  "apps.redeploy",
  "apps.rollback",
  "apps.restart",
  "apps.pause",
  "apps.destroy",
  "apps.logs",
  "apps.env",
  "services.deploy",
  "services.manage",
  "services.destroy",
  "services.logs",
  "services.link",
  "stacks.deploy",
  "stacks.view",
  "stacks.destroy",
  "servers.view",
  "servers.delete",
  "volumes.create",
  "volumes.manage",
  "volumes.delete",
  "scaling.manage",
  "webhooks.manage",
  "resources.view",
  "resources.create",
  "resources.delete",
  "environments.manage",
  "terminal.access",
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];

export function getUserCount(): number {
  const row = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number } | null;
  return row?.count ?? 0;
}

export function getUserByUsername(username: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
}

export function getUserById(id: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function getUsers(): UserRow[] {
  return db.query("SELECT id, username, is_admin, webauthn_enabled, created_at FROM users ORDER BY created_at").all() as UserRow[];
}

export function insertUser(user: { id: string; username: string; password_hash: string; is_admin?: boolean }): void {
  db.query("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)").run(
    user.id, user.username, user.password_hash, user.is_admin ? 1 : 0,
  );
}

export function updateUserPassword(id: string, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function deleteUser(id: string): void {
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

export function updateUserGitHub(
  userId: string,
  githubId: number,
  githubUsername: string,
  avatarUrl: string,
): void {
  db.query(
    "UPDATE users SET github_id = ?, github_username = ?, github_avatar_url = ?, github_linked_at = datetime('now') WHERE id = ?"
  ).run(githubId, githubUsername, avatarUrl, userId);
}

export function clearUserGitHub(userId: string): void {
  db.query(
    "UPDATE users SET github_id = NULL, github_username = '', github_avatar_url = '', github_linked_at = NULL WHERE id = ?"
  ).run(userId);
}

export function insertWebAuthnCredential(data: {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  name: string;
}): void {
  db.query(
    "INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    data.id,
    data.userId,
    Buffer.from(data.publicKey),
    data.counter,
    data.deviceType,
    data.backedUp ? 1 : 0,
    JSON.stringify(data.transports),
    data.name,
  );
}

export function getWebAuthnCredentials(userId: string): WebAuthnCredential[] {
  return db.query("SELECT * FROM webauthn_credentials WHERE user_id = ?").all(userId) as WebAuthnCredential[];
}

export function getWebAuthnCredentialById(credentialId: string): WebAuthnCredential | null {
  return (db.query("SELECT * FROM webauthn_credentials WHERE id = ?").get(credentialId) as WebAuthnCredential) ?? null;
}

export function updateWebAuthnCounter(credentialId: string, counter: number): void {
  db.query("UPDATE webauthn_credentials SET counter = ? WHERE id = ?").run(counter, credentialId);
}

export function deleteWebAuthnCredential(credentialId: string): void {
  db.query("DELETE FROM webauthn_credentials WHERE id = ?").run(credentialId);
}

export function enableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 1 WHERE id = ?").run(userId);
}

export function disableWebAuthn(userId: string): void {
  db.query("UPDATE users SET webauthn_enabled = 0 WHERE id = ?").run(userId);
  db.query("DELETE FROM webauthn_credentials WHERE user_id = ?").run(userId);
}

export function getWebAuthnCredentialCount(userId: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = ?").get(userId) as { count: number } | null;
  return row?.count ?? 0;
}

export function getUserPermissions(userId: string): string[] {
  const rows = db.query("SELECT permission FROM user_permissions WHERE user_id = ?").all(userId) as Array<{ permission: string }>;
  return rows.map((r) => r.permission);
}

export function hasPermission(userId: string, permission: string): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.is_admin) return true;
  const row = db.query("SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?").get(userId, permission);
  return !!row;
}

export function setUserPermissions(userId: string, permissions: string[]): void {
  db.query("DELETE FROM user_permissions WHERE user_id = ?").run(userId);
  const stmt = db.prepare("INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)");
  for (const perm of permissions) {
    stmt.run(userId, perm);
  }
}

export function incrementTokenVersion(userId: string): void {
  db.run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [userId]);
}
