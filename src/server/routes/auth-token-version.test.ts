import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

// Skip 2FA enforcement so login returns a real JWT in tests
process.env.SKIP_2FA = "1";

import { describe, test, expect, beforeEach } from "bun:test";
import * as db from "../../shared/db.ts";
import { handleLogin, handleSignOutAll, handleMe } from "./auth.ts";

function wipeUsers() {
  for (const u of db.getUsers()) db.deleteUser(u.id);
}

beforeEach(() => {
  wipeUsers();
});

async function createUser(username: string, password: string) {
  const id = crypto.randomUUID();
  const hash = await Bun.password.hash(password, "bcrypt");
  db.insertUser({ id, username, password_hash: hash });
  return id;
}

async function loginUser(username: string, password: string): Promise<string> {
  const req = new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const resp = await handleLogin(req);
  const body = (await resp.json()) as { token: string };
  return body.token;
}

function authedReq(url: string, token: string): Request {
  return new Request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function authedPost(url: string, token: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("token_version session revocation", () => {
  test("login issues token with v=0 for new user", async () => {
    await createUser("alice", "password123");
    const token = await loginUser("alice", "password123");

    // Decode payload (no verification — just inspecting claims)
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.v).toBe(0);
  });

  test("authenticated request succeeds with valid token", async () => {
    await createUser("bob", "password123");
    const token = await loginUser("bob", "password123");

    const resp = await handleMe(authedReq("http://localhost/api/me", token));
    expect(resp.status).toBe(200);
  });

  test("sign-out-all invalidates existing token", async () => {
    await createUser("charlie", "password123");
    const token = await loginUser("charlie", "password123");

    // Token works before sign-out-all
    const beforeResp = await handleMe(authedReq("http://localhost/api/me", token));
    expect(beforeResp.status).toBe(200);

    // Call sign-out-all
    const signOutResp = await handleSignOutAll(authedPost("http://localhost/api/auth/sign-out-all", token));
    expect(signOutResp.status).toBe(200);

    // Old token is now rejected
    const afterResp = await handleMe(authedReq("http://localhost/api/me", token));
    expect(afterResp.status).toBe(401);
  });

  test("sign-out-all requires authentication", async () => {
    const resp = await handleSignOutAll(
      new Request("http://localhost/api/auth/sign-out-all", { method: "POST" }),
    );
    expect(resp.status).toBe(401);
  });

  test("token after sign-out-all works for the signing-out user", async () => {
    // This tests that if the client refreshes its token after sign-out-all it gets a working one
    await createUser("dave", "password123");
    const oldToken = await loginUser("dave", "password123");

    // Sign out all
    await handleSignOutAll(authedPost("http://localhost/api/auth/sign-out-all", oldToken));

    // Log in fresh — should work
    const newToken = await loginUser("dave", "password123");
    const resp = await handleMe(authedReq("http://localhost/api/me", newToken));
    expect(resp.status).toBe(200);
  });

  test("incrementTokenVersion increments correctly", async () => {
    const id = await createUser("eve", "password123");
    const user1 = db.getUserById(id)!;
    expect(user1.token_version).toBe(0);

    db.incrementTokenVersion(id);
    const user2 = db.getUserById(id)!;
    expect(user2.token_version).toBe(1);

    db.incrementTokenVersion(id);
    const user3 = db.getUserById(id)!;
    expect(user3.token_version).toBe(2);
  });
});
