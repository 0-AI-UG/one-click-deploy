import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const users = db.getUsers();

    return Response.json(
      {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          isAdmin: u.is_admin === 1,
          webauthnEnabled: u.webauthn_enabled === 1,
          permissions: u.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(u.id),
          createdAt: u.created_at,
        })),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateUser(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as { username?: string; password?: string; permissions?: string[] };

    if (!body.username || !body.password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (body.password.length < 8) {
      return Response.json(
        { error: "Password must be at least 8 characters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const existing = db.getUserByUsername(body.username);
    if (existing) {
      return Response.json(
        { error: "Username already taken" },
        { status: 409, headers: corsHeaders },
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(body.password, "bcrypt");
    db.insertUser({ id, username: body.username, password_hash: passwordHash });

    if (body.permissions?.length) {
      const validPerms = body.permissions.filter((p) =>
        (db.ALL_PERMISSIONS as readonly string[]).includes(p),
      );
      db.setUserPermissions(id, validPerms);
    }

    return Response.json(
      {
        id,
        username: body.username,
        isAdmin: false,
        permissions: body.permissions || [],
        createdAt: new Date().toISOString(),
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

const SCOPE_TYPES = new Set(["global", "environment", "app"]);

/** Keep only grants naming a real permission and a real scope type. Anything
 *  else is dropped rather than rejected: the admin UI posts the whole grant set
 *  on every save, so one stale entry must not fail the request. Scoped grants
 *  for non-scopable permissions are dropped further down, by setUserPermissions. */
function sanitizeGrants(grants: db.PermissionGrant[]): db.PermissionGrant[] {
  return grants
    .filter((g) =>
      !!g &&
      (db.ALL_PERMISSIONS as readonly string[]).includes(g.permission) &&
      SCOPE_TYPES.has(g.scopeType),
    )
    .map((g) => ({
      permission: g.permission,
      scopeType: g.scopeType,
      scopeId: g.scopeType === "global" ? null : (g.scopeId == null ? null : String(g.scopeId)),
    }));
}

export async function handleUpdateUser(request: Request, userId: string): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as {
      password?: string;
      permissions?: string[];
      grants?: db.PermissionGrant[];
    };

    const user = db.getUserById(userId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    if (body.password) {
      if (body.password.length < 8) {
        return Response.json(
          { error: "Password must be at least 8 characters" },
          { status: 400, headers: corsHeaders },
        );
      }
      const hash = await Bun.password.hash(body.password, "bcrypt");
      db.updateUserPassword(userId, hash);
    }

    // `grants` is the full model and wins when both are sent; `permissions` is
    // the legacy global-only shape, still accepted for older clients.
    if (!user.is_admin) {
      if (Array.isArray(body.grants)) {
        db.setUserPermissions(userId, sanitizeGrants(body.grants));
      } else if (body.permissions !== undefined) {
        const validPerms = body.permissions.filter((p) =>
          (db.ALL_PERMISSIONS as readonly string[]).includes(p),
        );
        db.setUserPermissions(userId, validPerms);
      }
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteUser(request: Request, targetId: string): Promise<Response> {
  try {
    const { userId: adminId } = await requireAdmin(request);

    if (targetId === adminId) {
      return Response.json(
        { error: "Cannot delete your own account" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = db.getUserById(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    db.deleteUser(targetId);
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetUserPermissions(request: Request, userId: string): Promise<Response> {
  try {
    await requireAdmin(request);
    const user = db.getUserById(userId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    // An admin implicitly holds everything, fleet-wide; report that as a full
    // set of global grants so the editor renders the same way for both cases.
    const grants: db.PermissionGrant[] = user.is_admin
      ? db.ALL_PERMISSIONS.map((permission) => ({ permission, scopeType: "global" as const, scopeId: null }))
      : db.getUserGrants(userId);

    return Response.json(
      {
        grants,
        // Legacy field: the global permission strings only.
        permissions: grants.filter((g) => g.scopeType === "global").map((g) => g.permission),
        allPermissions: db.ALL_PERMISSIONS,
        scopablePermissions: [...db.SCOPABLE_PERMISSIONS],
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
