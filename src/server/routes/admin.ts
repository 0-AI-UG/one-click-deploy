import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const users = db.getUsers();

    return Response.json(
      {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          isAdmin: u.is_admin === 1,
          totpEnabled: u.totp_enabled === 1,
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
    const body = await request.json() as { email?: string; password?: string; permissions?: string[] };

    if (!body.email || !body.password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (body.password.length < 8) {
      return Response.json(
        { error: "Password must be at least 8 characters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const existing = db.getUserByEmail(body.email);
    if (existing) {
      return Response.json(
        { error: "Email already registered" },
        { status: 409, headers: corsHeaders },
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(body.password, "bcrypt");
    db.insertUser({ id, email: body.email, password_hash: passwordHash });

    if (body.permissions?.length) {
      const validPerms = body.permissions.filter((p) =>
        (db.ALL_PERMISSIONS as readonly string[]).includes(p),
      );
      db.setUserPermissions(id, validPerms);
    }

    return Response.json(
      {
        id,
        email: body.email,
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

export async function handleUpdateUser(request: Request, userId: string): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as { password?: string; permissions?: string[] };

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

    if (body.permissions !== undefined && !user.is_admin) {
      const validPerms = body.permissions.filter((p) =>
        (db.ALL_PERMISSIONS as readonly string[]).includes(p),
      );
      db.setUserPermissions(userId, validPerms);
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

    const permissions = user.is_admin ? db.ALL_PERMISSIONS.slice() : db.getUserPermissions(userId);
    return Response.json(
      { permissions, allPermissions: db.ALL_PERMISSIONS },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
