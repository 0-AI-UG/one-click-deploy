import { corsHeaders } from "../lib/cors.ts";
import { createTempToken } from "../lib/auth.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

export function isSetupComplete(): boolean {
  return db.getUserCount() > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  return Response.json(
    {
      setupComplete: isSetupComplete(),
    },
    { headers: corsHeaders },
  );
}

export async function handleSetupComplete(request: Request): Promise<Response> {
  try {
    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders },
      );
    }

    const body = await request.json() as Record<string, string>;
    const { username, password, default_domain_suffix } = body;

    if (!username || !password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const suffix = (default_domain_suffix || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (suffix && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(suffix)) {
      return Response.json(
        { error: "default_domain_suffix must be a valid DNS suffix such as apps.example.com" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Create admin user
    const userId = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.insertUser({ id: userId, username, password_hash: passwordHash, is_admin: true });

    // Store non-secret settings
    db.saveSetting("default_domain_suffix", suffix);

    // Return temp token for mandatory 2FA setup
    const createdUser = db.getUserById(userId)!;
    const tempToken = await createTempToken(userId, createdUser.token_version);

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, username } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
