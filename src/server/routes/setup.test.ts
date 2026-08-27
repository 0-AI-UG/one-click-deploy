import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../lib/auth.ts", () => ({
  createTempToken: async (userId: string) => `temp.${userId}`,
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { handleSetupComplete, handleSetupStatus, isSetupComplete } from "./setup.ts";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  for (const user of db.getUsers()) db.deleteUser(user.id);
  await secretStore.delete("hetzner_api_token");
});

describe("provider-neutral initial setup", () => {
  test("reports only account setup state", async () => {
    expect(isSetupComplete()).toBe(false);
    const response = await handleSetupStatus(new Request("http://localhost/api/setup/status"));
    expect(await response.json()).toEqual({ setupComplete: false });
  });

  test("creates the admin without infrastructure credentials", async () => {
    const response = await handleSetupComplete(jsonReq({ username: "admin", password: "correct-horse" }));
    expect(response.status).toBe(201);
    expect(await secretStore.get("hetzner_api_token")).toBeNull();
    expect(db.getUsers()).toHaveLength(1);
  });

  test("normalizes the optional provider-neutral domain suffix", async () => {
    const response = await handleSetupComplete(jsonReq({
      username: "admin",
      password: "correct-horse",
      default_domain_suffix: "Apps.Example.org.",
    }));
    expect(response.status).toBe(201);
    expect(db.getSettings().default_domain_suffix).toBe("apps.example.org");
  });

  test("validates required account fields and domain suffix before creating a user", async () => {
    expect((await handleSetupComplete(jsonReq({ username: "admin" }))).status).toBe(400);
    expect((await handleSetupComplete(jsonReq({
      username: "admin",
      password: "correct-horse",
      default_domain_suffix: "not a domain",
    }))).status).toBe(400);
    expect(db.getUsers()).toHaveLength(0);
  });

  test("rejects a second setup and stores a bcrypt password hash", async () => {
    await handleSetupComplete(jsonReq({ username: "admin", password: "plaintext-secret" }));
    const user = db.getUserByUsername("admin")!;
    expect(user.password_hash).not.toBe("plaintext-secret");
    expect(await Bun.password.verify("plaintext-secret", user.password_hash)).toBe(true);
    expect((await handleSetupComplete(jsonReq({ username: "other", password: "correct-horse" }))).status).toBe(400);
  });
});
