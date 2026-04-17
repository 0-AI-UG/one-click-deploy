import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../lib/auth.ts", () => ({
  createTempToken: async (userId: string) => `temp.${userId}`,
}));

import * as db from "../../shared/db.ts";
import {
  handleSetupStatus,
  handleSetupComplete,
  isSetupComplete,
} from "./setup.ts";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function wipeUsers() {
  for (const u of db.getUsers()) db.deleteUser(u.id);
}

beforeEach(() => {
  wipeUsers();
});

describe("isSetupComplete / handleSetupStatus", () => {
  test("initial state: setup not complete", async () => {
    expect(isSetupComplete()).toBe(false);
    const r = await handleSetupStatus(new Request("http://localhost/setup"));
    const body = (await r.json()) as { setupComplete: boolean };
    expect(body.setupComplete).toBe(false);
  });

  test("setupComplete flips true once a user exists", async () => {
    db.insertUser({
      id: crypto.randomUUID(),
      username: "admin",
      password_hash: "x",
    });
    expect(isSetupComplete()).toBe(true);
  });
});

describe("handleSetupComplete", () => {
  test("rejects with 400 once a user exists", async () => {
    db.insertUser({ id: "u1", username: "a", password_hash: "x" });
    const r = await handleSetupComplete(jsonReq({ username: "b", password: "pw" }));
    expect(r.status).toBe(400);
  });

  test("requires both username and password", async () => {
    let r = await handleSetupComplete(jsonReq({ username: "a" }));
    expect(r.status).toBe(400);
    r = await handleSetupComplete(jsonReq({ password: "p" }));
    expect(r.status).toBe(400);
  });

  test("creates user and returns tempToken for 2FA setup", async () => {
    const r = await handleSetupComplete(
      jsonReq({ username: "admin", password: "correct-horse" }),
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { tempToken: string; user: { username: string } };
    expect(body.tempToken).toMatch(/^temp\./);
    expect(body.user.username).toBe("admin");

    const users = db.getUsers();
    expect(users).toHaveLength(1);
  });

  test("stores a bcrypt-hashed password (never the plaintext)", async () => {
    await handleSetupComplete(
      jsonReq({ username: "admin", password: "plaintext-secret" }),
    );
    const u = db.getUserByUsername("admin");
    expect(u).not.toBeNull();
    expect(u!.password_hash).not.toBe("plaintext-secret");
    expect(u!.password_hash.startsWith("$2")).toBe(true);
    expect(await Bun.password.verify("plaintext-secret", u!.password_hash)).toBe(true);
  });
});
