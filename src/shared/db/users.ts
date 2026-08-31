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
  // --- Client access ---------------------------------------------------
  /** Use the `ocd` CLI at all. Enforced on every CLI-minted token (client:"cli"),
   *  so revoking it locks a user to the web UI without touching their other grants. */
  "cli.access",

  // --- Read ------------------------------------------------------------
  "fleet.view",
  "apps.view",
  "environments.view",
  "metrics.view",
  "operations.view",
  "deployments.view",

  // --- Apps ------------------------------------------------------------
  "apps.deploy",
  "apps.rollback",
  "apps.restart",
  "apps.pause",
  "apps.destroy",
  "apps.logs",
  "apps.promote",

  // --- Stacks ----------------------------------------------------------
  "stacks.view",
  "stacks.deploy",
  "stacks.promote",
  "stacks.destroy",

  // --- Environments ----------------------------------------------------
  "environments.manage",
  /** Reading/writing env var values, which are secrets. Separate from the
   *  environment lifecycle grant so credentials can be restricted. */
  "environments.secrets",

  // --- Scaling ---------------------------------------------------------
  "scaling.migrate",

  // --- Servers ---------------------------------------------------------
  "servers.create",
  "servers.manage",
  "servers.delete",

  // --- Volumes ---------------------------------------------------------
  "volumes.delete",
  /** Browsing and reading file contents off a volume — i.e. application data. */
  "volumes.files.read",

  // --- Other cloud resources ------------------------------------------
  "resources.view",
  "resources.delete",

  // --- Operations ------------------------------------------------------
  "operations.cancel",

  // --- Control plane ---------------------------------------------------
  "panel.view",
  "panel.manage",

  // --- Terminal --------------------------------------------------------
  "terminal.container",
  /** Shell on a fleet host. Root-equivalent; effectively an admin grant. */
  "terminal.host",
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];

/** Which scope kinds are meaningful for each permission.
 *
 *  This is not cosmetic — it mirrors how the route actually checks. Offering a
 *  scope the check can never match would hand out a grant that silently does
 *  nothing:
 *   - routes that check with `envScope()`/`stackScope()` can only ever be
 *     satisfied by an environment grant, so those permissions are environment-only;
 *   - routes that check with `appScope()` are satisfied by an app grant *or* by
 *     the environment that owns the app, so both kinds apply;
 *   - permissions whose routes are all unscoped are absent entirely and stay
 *     global-only. `apps.deploy` is the notable one: every call site is unscoped
 *     (there is no app yet at deploy time), so a scoped grant is unsatisfiable.
 *
 *  Anything not listed here governs infrastructure no environment owns (servers,
 *  volumes, the panel, host terminal) and is global-only. `setUserPermissions`
 *  drops scoped grants for anything absent.
 */
export const PERMISSION_SCOPES: Readonly<Record<string, readonly ScopeType[]>> = {
  // --- environment-only: checked via envScope()/stackScope() ---------------
  "environments.view": ["environment"],
  "environments.secrets": ["environment"],
  // A stack has no environment of its own; stackScope() resolves it from the
  // members' shared environment, so only an environment grant can match.
  "stacks.view": ["environment"],
  "stacks.promote": ["environment"],
  "stacks.destroy": ["environment"],

  // --- app-only: operations that only make sense against one app -----------
  "scaling.migrate": ["app"],
  "terminal.container": ["app"],

  // --- app or environment: checked via appScope(), which inherits the app's
  //     environment, so granting the environment covers every app inside it ---
  "apps.view": ["app", "environment"],
  "apps.rollback": ["app", "environment"],
  "apps.restart": ["app", "environment"],
  "apps.pause": ["app", "environment"],
  "apps.destroy": ["app", "environment"],
  "apps.logs": ["app", "environment"],
  "apps.promote": ["app", "environment"],
  "deployments.view": ["app", "environment"],
  "metrics.view": ["app", "environment"],
} as const;

/** Permissions that can be granted narrowly instead of fleet-wide. */
export const SCOPABLE_PERMISSIONS: ReadonlySet<string> = new Set(Object.keys(PERMISSION_SCOPES));

/** The scope kinds valid for a permission ([] when it is global-only). */
export function scopeKindsFor(permission: string): readonly ScopeType[] {
  return PERMISSION_SCOPES[permission] ?? [];
}

export type ScopeType = "global" | "environment" | "app";

/** One row of user_permissions. `scopeId` is null exactly when scopeType is
 *  "global"; otherwise it is an app id or environment id (stored as TEXT). */
export type PermissionGrant = {
  permission: string;
  scopeType: ScopeType;
  scopeId: string | null;
};

/** What a permission check is being made *about*. Callers pass whichever ids
 *  they have; an app id alone is enough, since the app's environment is looked
 *  up here to honour environment-scoped grants. */
export type PermissionScope = {
  appId?: number | null;
  environmentId?: number | null;
};

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

/** Every grant a user holds, scope included. */
export function getUserGrants(userId: string): PermissionGrant[] {
  const rows = db
    .query("SELECT permission, scope_type, scope_id FROM user_permissions WHERE user_id = ?")
    .all(userId) as Array<{ permission: string; scope_type: string; scope_id: string | null }>;
  return rows.map((r) => ({
    permission: r.permission,
    scopeType: (r.scope_type as ScopeType) ?? "global",
    scopeId: r.scope_id,
  }));
}

/** The user's *global* permissions only. Kept for callers that just want to
 *  know "what can this user do fleet-wide" — a scoped grant is deliberately
 *  invisible here, because it does not authorize the unscoped operation. */
export function getUserPermissions(userId: string): string[] {
  const rows = db
    .query("SELECT permission FROM user_permissions WHERE user_id = ? AND scope_type = 'global'")
    .all(userId) as Array<{ permission: string }>;
  return rows.map((r) => r.permission);
}

/** Resolve which environment an app belongs to, for environment-scoped grants.
 *  Local query rather than an import from apps.ts to keep this module leaf-level. */
function environmentIdForApp(appId: number): number | null {
  const row = db.query("SELECT environment_id FROM apps WHERE id = ?").get(appId) as
    | { environment_id: number | null }
    | undefined;
  return row?.environment_id ?? null;
}

/** Does `userId` hold `permission`, optionally for a specific app/environment?
 *
 *  A global grant always wins. When `scope` is supplied, a grant scoped to that
 *  exact app also wins, as does a grant scoped to the environment that owns the
 *  app. Calling without a scope therefore means "fleet-wide" and only a global
 *  grant satisfies it — that is what keeps a narrowly-scoped user from passing
 *  a check on a route that never resolved which resource it was acting on. */
export function hasPermission(userId: string, permission: string, scope?: PermissionScope): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.is_admin) return true;

  const global = db
    .query("SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ? AND scope_type = 'global'")
    .get(userId, permission);
  if (global) return true;

  if (!scope || !SCOPABLE_PERMISSIONS.has(permission)) return false;

  if (scope.appId != null) {
    const appGrant = db
      .query(
        "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ? AND scope_type = 'app' AND scope_id = ?",
      )
      .get(userId, permission, String(scope.appId));
    if (appGrant) return true;
  }

  // An app inherits its environment's grants; an explicit environmentId (e.g.
  // an environment route) is used as-is.
  const envId = scope.environmentId ?? (scope.appId != null ? environmentIdForApp(scope.appId) : null);
  if (envId != null) {
    const envGrant = db
      .query(
        "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ? AND scope_type = 'environment' AND scope_id = ?",
      )
      .get(userId, permission, String(envId));
    if (envGrant) return true;
  }

  return false;
}

/** Replace a user's grants wholesale. Accepts bare strings (treated as global)
 *  or full grants. Scoped grants for non-scopable permissions are dropped
 *  rather than silently stored as something that could never match. */
export function setUserPermissions(userId: string, permissions: Array<string | PermissionGrant>): void {
  db.query("DELETE FROM user_permissions WHERE user_id = ?").run(userId);
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO user_permissions (user_id, permission, scope_type, scope_id) VALUES (?, ?, ?, ?)",
  );
  for (const entry of permissions) {
    const grant: PermissionGrant =
      typeof entry === "string" ? { permission: entry, scopeType: "global", scopeId: null } : entry;
    if (grant.scopeType !== "global") {
      // Drop a scope kind the permission's checks can never match — storing it
      // would present as access granted while denying every request.
      if (!scopeKindsFor(grant.permission).includes(grant.scopeType)) continue;
      if (grant.scopeId == null || grant.scopeId === "") continue;
    }
    stmt.run(
      userId,
      grant.permission,
      grant.scopeType,
      grant.scopeType === "global" ? null : String(grant.scopeId),
    );
  }
}

export function incrementTokenVersion(userId: string): void {
  db.run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [userId]);
}
